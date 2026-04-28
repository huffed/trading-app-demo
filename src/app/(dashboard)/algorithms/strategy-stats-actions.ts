"use server";

import { getAuthedUser } from "@/lib/supabase/get-authed-user";
import { type ActionResult } from "@/lib/types/action-result";
import type {
  ConditionStatRow,
  PairStatRow,
  StrategyStats,
} from "@/types/strategy-stats";

interface ConditionMet {
  type?: string;
  indicator?: string;
  operator?: string;
  value?: number | string;
  metric?: string;
  threshold?: number;
}

interface EntryReason {
  conditions_met?: ConditionMet[];
}

interface PositionRow {
  ticker: string;
  realized_pnl: number | null;
  entry_reason: EntryReason | null;
}

const OPERATOR_GLYPHS: Record<string, string> = {
  less_than: "<",
  greater_than: ">",
  crosses_above: "↑",
  crosses_below: "↓",
  above: ">",
  below: "<",
  spike_above: "↑↑",
  spike_below: "↓↓",
};

/** Render one condition as a short, sortable token e.g. "RSI<50". */
function tokenForCondition(c: ConditionMet): string {
  const op = OPERATOR_GLYPHS[c.operator ?? ""] ?? c.operator ?? "?";
  if (c.type === "sentiment") {
    const metric = c.metric ?? "sentiment";
    const value = c.threshold ?? "?";
    return `${metric}${op}${value}`;
  }
  const indicator = c.indicator ?? "?";
  const value = c.value ?? "?";
  return `${indicator}${op}${value}`;
}

/**
 * Build a stable, human-readable signature for a set of conditions. Tokens
 * are sorted so {RSI<50, EMA12>0} and {EMA12>0, RSI<50} hash to the same
 * signature — the order they fire in shouldn't change the bucket.
 */
function signatureFor(reason: EntryReason | null): string | null {
  if (!reason?.conditions_met || reason.conditions_met.length === 0) return null;
  const tokens = reason.conditions_met.map(tokenForCondition).sort();
  return tokens.join(" + ");
}

interface SignatureBucket {
  trades: number;
  wins: number;
  losses: number;
  total_pnl_usd: number;
  per_pair: Map<string, { trades: number; wins: number; pnl_usd: number }>;
}

interface PairBucket {
  trades: number;
  wins: number;
  losses: number;
  total_pnl_usd: number;
}

function aggregate(rows: PositionRow[]): {
  bySig: Map<string, SignatureBucket>;
  byPair: Map<string, PairBucket>;
  excluded: number;
} {
  const bySig = new Map<string, SignatureBucket>();
  const byPair = new Map<string, PairBucket>();
  let excluded = 0;

  for (const row of rows) {
    const sig = signatureFor(row.entry_reason);
    const pnl = row.realized_pnl ?? 0;
    const isWin = pnl > 0;

    if (!sig) {
      excluded++;
    } else {
      const bucket = bySig.get(sig) ?? {
        trades: 0,
        wins: 0,
        losses: 0,
        total_pnl_usd: 0,
        per_pair: new Map(),
      };
      bucket.trades++;
      bucket.total_pnl_usd += pnl;
      if (isWin) bucket.wins++;
      else bucket.losses++;

      const pp = bucket.per_pair.get(row.ticker) ?? { trades: 0, wins: 0, pnl_usd: 0 };
      pp.trades++;
      pp.pnl_usd += pnl;
      if (isWin) pp.wins++;
      bucket.per_pair.set(row.ticker, pp);
      bySig.set(sig, bucket);
    }

    const pair = byPair.get(row.ticker) ?? {
      trades: 0,
      wins: 0,
      losses: 0,
      total_pnl_usd: 0,
    };
    pair.trades++;
    pair.total_pnl_usd += pnl;
    if (isWin) pair.wins++;
    else pair.losses++;
    byPair.set(row.ticker, pair);
  }

  return { bySig, byPair, excluded };
}

function toSigRows(bySig: Map<string, SignatureBucket>): ConditionStatRow[] {
  const rows: ConditionStatRow[] = [];
  for (const [signature, b] of bySig) {
    const per_pair: ConditionStatRow["per_pair"] = {};
    for (const [ticker, pp] of b.per_pair) {
      per_pair[ticker] = {
        trades: pp.trades,
        wins: pp.wins,
        pnl_usd: Number(pp.pnl_usd.toFixed(2)),
      };
    }
    rows.push({
      signature,
      trades: b.trades,
      wins: b.wins,
      losses: b.losses,
      win_rate_pct: Number(((b.wins / b.trades) * 100).toFixed(1)),
      total_pnl_usd: Number(b.total_pnl_usd.toFixed(2)),
      avg_pnl_usd: Number((b.total_pnl_usd / b.trades).toFixed(2)),
      per_pair,
    });
  }
  return rows.sort((a, b) => b.trades - a.trades);
}

function toPairRows(byPair: Map<string, PairBucket>): PairStatRow[] {
  const rows: PairStatRow[] = [];
  for (const [ticker, b] of byPair) {
    rows.push({
      ticker,
      trades: b.trades,
      wins: b.wins,
      losses: b.losses,
      win_rate_pct: Number(((b.wins / b.trades) * 100).toFixed(1)),
      total_pnl_usd: Number(b.total_pnl_usd.toFixed(2)),
      avg_pnl_usd: Number((b.total_pnl_usd / b.trades).toFixed(2)),
    });
  }
  return rows.sort((a, b) => b.trades - a.trades);
}

/**
 * Aggregate closed-trade outcomes for an algorithm by condition signature
 * and by pair. Drives the Strategy Stats tab — answers "which combos and
 * which pairs are pulling weight; which are dead weight."
 */
export async function getStrategyStats(
  algorithmId: string
): Promise<ActionResult<StrategyStats>> {
  try {
    const { supabase, user } = await getAuthedUser();

    const { data, error } = await supabase
      .from("paper_positions")
      .select("ticker, realized_pnl, entry_reason")
      .eq("algorithm_id", algorithmId)
      .eq("user_id", user.id)
      .eq("status", "closed");

    if (error) return { success: false, error: error.message };

    const rows = (data ?? []) as unknown as PositionRow[];
    if (rows.length === 0) {
      return {
        success: true,
        data: { total_closed_trades: 0, excluded_trades: 0, by_signature: [], by_pair: [] },
      };
    }

    const { bySig, byPair, excluded } = aggregate(rows);

    return {
      success: true,
      data: {
        total_closed_trades: rows.length,
        excluded_trades: excluded,
        by_signature: toSigRows(bySig),
        by_pair: toPairRows(byPair),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to load stats";
    return { success: false, error: msg };
  }
}
