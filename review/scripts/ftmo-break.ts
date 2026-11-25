/**
 * FTMO item 1 — which entries and exits fall inside FTMO's XAU/USD nightly break.
 * Entry time = the signal bar's close (entry_date + 4h), because the engine fills at that close
 * (portfolio-backtest.ts:990, :1046). Exit bars are placed by the engine's own hit rule on 4h bars and then
 * timed on the M30 pin; the M30 bars that straddle 16:50 or 18:05 New York cannot be split without finer data.
 * Also lists the paper record. Counts and lists only: nothing is re-priced.
 * Reproduce: pnpm exec tsx review/scripts/ftmo-break.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dateIndexOf, loadDeployedMembers, reconstructGeometry, runSiblingAware } from "./lib/harness";
import { CANONICAL_PINS, loadPinnedFile, sessionDaily } from "./lib/pins";
import { closedKind, nyLabel, rollovers, seasonOf, zoneOffsetMinutes, type Clock } from "./lib/ftmo";
import type { BacktestTrade, PriceBar } from "../../src/lib/market-data/types";

const CAP = 100_000;
const RISK = 0.42;
const H4_MS = 4 * 3_600_000;
const M30_MS = 30 * 60_000;
const CLOCKS: Clock[] = ["us", "fixed2", "eu"];

interface PaperRow {
  algo: string;
  side: string;
  opened_at: string;
  closed_at: string;
  entry_price: number;
  exit_price: number;
  exit_reason: string;
}

/** The 18 closed paper positions since 2026-07-20, as read from the database on 2026-11-25. */
const PAPER = (JSON.parse(readFileSync("review/inputs/paper-record-2026-11-25.json", "utf-8")) as { rows: PaperRow[] }).rows;

interface ExitPlacement {
  kind: string;
  hitBarOpen: string | null;
  m30: string | null;
  exit4h: string | null;
}

function nyMinute(ms: number): number {
  const local = new Date(ms + zoneOffsetMinutes("America/New_York", ms) * 60_000);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

/** Where an exit's level was first touched inside the exit day, on the M30 pin: "clear", or the straddle it falls in. */
function placeExit(t: BacktestTrade, sl: number, tp: number, idx: number, bars: PriceBar[], m30: Map<number, PriceBar>): ExitPlacement {
  for (let j = idx + 1; j < bars.length; j++) {
    const b = bars[j];
    if (b.date.slice(0, 10) !== t.exit_date.slice(0, 10)) {
      if (b.date.slice(0, 10) > t.exit_date.slice(0, 10)) {
        break;
      }
      continue;
    }
    const hit = b.low <= sl || b.high >= tp;
    if (!hit) {
      continue;
    }
    const start = Date.parse(b.date);
    for (let k = start; k < start + H4_MS; k += M30_MS) {
      const m = m30.get(k);
      if (!m || (m.low > sl && m.high < tp)) {
        continue;
      }
      const ny = nyMinute(k);
      const straddle = ny === 16 * 60 + 30 ? "16:30–17:00 NY (contains FTMO's 16:50 close)" : ny === 18 * 60 ? "18:00–18:30 NY (contains FTMO's 18:05 reopen)" : null;
      return { kind: straddle ?? "clear", hitBarOpen: b.date, m30: new Date(k).toISOString(), exit4h: b.date };
    }
    return { kind: "hit not seen on M30 (a 4h/M30 price gap or rounding)", hitBarOpen: b.date, m30: null, exit4h: b.date };
  }
  return { kind: "unplaced", hitBarOpen: null, m30: null, exit4h: null };
}

async function main(): Promise<void> {
  const h4 = loadPinnedFile(CANONICAL_PINS.h4).bars;
  const daily = sessionDaily(loadPinnedFile(CANONICAL_PINS.d).bars);
  const m30 = new Map(loadPinnedFile("scripts/canonical/data/xau-usd-m30-pinned.json").bars.map((b) => [Date.parse(b.date), b]));
  const idx = dateIndexOf(h4);
  const members = await loadDeployedMembers();
  const rulesOf = new Map(members.map((m) => [m.label, m.rules]));
  const run = runSiblingAware(members, h4, daily, CAP, { uniformRisk: RISK });
  const trades = run.union as Array<BacktestTrade & { algo: string }>;

  const entries = trades.map((t) => {
    const fill = Date.parse(t.entry_date) + H4_MS;
    const g = reconstructGeometry(t, rulesOf.get(t.algo)!, h4, idx);
    const kinds = Object.fromEntries(CLOCKS.map((c) => [c, closedKind(fill, c)])) as Record<Clock, string>;
    const placed = g ? placeExit(t, g.sl, g.tp, g.idx, h4, m30) : { kind: "no geometry", hitBarOpen: null, m30: null, exit4h: null };
    return { t, fill, kinds, placed, season: seasonOf(fill), nights: placed.exit4h ? rollovers(fill, Date.parse(placed.exit4h)) : [] };
  });

  const table = (clock: Clock, pick: (e: (typeof entries)[number]) => string) => {
    const out: Record<string, number> = {};
    for (const e of entries) {
      const k = pick(e);
      out[k] = (out[k] ?? 0) + (e.kinds[clock] === "open" ? 0 : 1);
    }
    return out;
  };

  const perClock = Object.fromEntries(
    CLOCKS.map((clock) => {
      const inBreak = entries.filter((e) => e.kinds[clock] !== "open");
      const byAlgoSeasonKind: Record<string, number> = {};
      for (const e of inBreak) {
        const key = `${e.t.algo} | ${e.season} | ${e.kinds[clock]}`;
        byAlgoSeasonKind[key] = (byAlgoSeasonKind[key] ?? 0) + 1;
      }
      return [
        clock,
        {
          in_break: inBreak.length,
          share_pct: (100 * inBreak.length) / entries.length,
          nightly: inBreak.filter((e) => e.kinds[clock] === "nightly").length,
          weekend: inBreak.filter((e) => e.kinds[clock] === "weekend").length,
          by_algo: table(clock, (e) => e.t.algo),
          by_season: table(clock, (e) => e.season),
          by_algo_season_kind: byAlgoSeasonKind,
        },
      ];
    })
  );

  const exits: Record<string, number> = {};
  for (const e of entries) {
    exits[e.placed.kind] = (exits[e.placed.kind] ?? 0) + 1;
  }

  const usRows = entries.filter((e) => e.kinds.us !== "open");
  const tickDays = new Set(
    Object.keys((JSON.parse(readFileSync("scripts/canonical/data/ticks-manifest.json", "utf-8")) as { XAUUSD: Record<string, unknown> }).XAUUSD)
  );
  const straddles = entries.filter((e) => e.placed.kind.includes("(contains"));
  const hasTicks = (e: (typeof entries)[number]): boolean => tickDays.has((e.placed.m30 ?? "").slice(0, 10));
  const exitCsv = ["algo,exit_date,m30_start_utc,m30_start_ny,placement,exit_reason,tick_data_on_disk"].concat(
    [...straddles]
      .sort((a, b) => (a.placed.m30 ?? "").localeCompare(b.placed.m30 ?? ""))
      .map((e) =>
        [e.t.algo, e.t.exit_date, e.placed.m30, nyLabel(Date.parse(e.placed.m30 ?? "")), e.placed.kind.slice(0, 14), e.t.exit_reason, hasTicks(e) ? "yes" : "no"].join(",")
      )
  );
  writeFileSync("review/results/ftmo-break-exits.csv", exitCsv.join("\n") + "\n");
  // FTMO's daily loss resets at midnight Prague: an exit between it and 00:00 UTC is on the next FTMO day and on this UTC day.
  const pragueDay = (ms: number): string => new Date(ms + zoneOffsetMinutes("Europe/Prague", ms) * 60_000).toISOString().slice(0, 10);
  const placedExits = entries.filter((e) => e.placed.m30 !== null);
  const utcNotPrague = placedExits.filter((e) => pragueDay(Date.parse(e.placed.m30 ?? "")) !== (e.placed.m30 ?? "").slice(0, 10)).length;
  const distinctBars = new Set(entries.filter((e) => e.kinds.us !== "open").map((e) => e.t.entry_date)).size;

  const csv = ["algo,season,kind,signal_bar_utc,fill_utc,fill_ny,entry_price,exit_date,exit_reason,r_after_engine_costs,exit_placement"]
    .concat(
      usRows
        .sort((a, b) => a.fill - b.fill)
        .map((e) => [e.t.algo, e.season, e.kinds.us, e.t.entry_date, new Date(e.fill).toISOString(), nyLabel(e.fill), e.t.entry_price, e.t.exit_date, e.t.exit_reason, (e.t.pnl / (((e.t.equity_at_entry ?? CAP) * RISK) / 100)).toFixed(3), e.placed.kind].join(","))
    )
    .join("\n");
  writeFileSync("review/results/ftmo-break-trades.csv", csv + "\n");

  const paper = PAPER.map((p) => {
    const open = Date.parse(p.opened_at);
    const close = Date.parse(p.closed_at);
    return {
      algo: p.algo,
      opened_at: p.opened_at,
      opened_ny: nyLabel(open),
      open_in_break: closedKind(open, "us"),
      closed_at: p.closed_at,
      closed_ny: nyLabel(close),
      close_in_break: closedKind(close, "us"),
      season_open: seasonOf(open),
      exit_reason: p.exit_reason,
      entry_price: p.entry_price,
      exit_price: p.exit_price,
      clocks: Object.fromEntries(CLOCKS.map((c) => [c, { open: closedKind(open, c), close: closedKind(close, c) }])),
    };
  });

  const out = { n: entries.length, entry_rule: "fill = signal bar close = entry_date + 4h", clocks: perClock, exits_by_placement: exits, distinct_signal_bars_in_break: distinctBars, straddle_exits: straddles.length, straddle_exits_with_ticks: straddles.filter(hasTicks).length, exits_on_a_utc_day_that_is_not_the_prague_day: utcNotPrague, exits_placed_on_m30: placedExits.length, paper, generated_at: new Date().toISOString() };
  writeFileSync("review/results/ftmo-break.json", JSON.stringify(out, null, 1));
  const us = (perClock as Record<string, { in_break: number; nightly: number; weekend: number; by_algo: Record<string, number>; by_season: Record<string, number>; by_algo_season_kind: Record<string, number> }>).us;
  console.log(JSON.stringify({ distinctBars, straddles: straddles.length, with_ticks: straddles.filter(hasTicks).length, utcNotPrague, placedExits: placedExits.length }));
  console.log(JSON.stringify({ n: entries.length, us, fixed2: perClock.fixed2, eu: perClock.eu, exits }, null, 1));
  console.log(JSON.stringify(paper.filter((p) => p.open_in_break !== "open" || p.close_in_break !== "open"), null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
