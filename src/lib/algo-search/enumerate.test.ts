/**
 * Algorithm-search Layer A enumerator regression tests.
 *
 * Locks the Bonferroni denominator + axis cardinality so a silent change
 * to the pattern catalog / instrument list / TF set immediately surfaces
 * as a failing test (the family-N number is methodology-critical).
 */
import { describe, expect, it } from "vitest";
import {
  CANDIDATE_NAME_PREFIX,
  enumerateLayerACandidates,
  layerACardinality,
  SEARCH_INSTRUMENTS,
  SEARCH_PATTERNS,
  SEARCH_TIMEFRAMES,
} from "./enumerate";

describe("algo-search Layer A enumerator", () => {
  it("produces 368 candidates (Bonferroni denominator — H.4c expanded from 308)", () => {
    expect(layerACardinality()).toBe(368);
  });

  it("axis decomposition: 14 L+S patterns × 4 inst × 3 TFs × 2 dirs + 2 long-only (ote+doji, 24) + asian_range_break (8) = 368", () => {
    const lsPatterns = SEARCH_PATTERNS.filter(
      (p) => p.supportsShort && !p.allowedTimeframes,
    ).length;
    const longOnlyPatterns = SEARCH_PATTERNS.filter(
      (p) => !p.supportsShort && !p.allowedTimeframes,
    ).length;
    const restrictedPatterns = SEARCH_PATTERNS.filter((p) => p.allowedTimeframes).length;
    expect(lsPatterns).toBe(14); // H.4c added inside_bar + outside_bar
    expect(longOnlyPatterns).toBe(2); // ote + doji (H.4c added doji as long-only direction-agnostic)
    expect(restrictedPatterns).toBe(1);
    expect(SEARCH_INSTRUMENTS).toHaveLength(4);
    expect(SEARCH_TIMEFRAMES).toHaveLength(3);

    const expected =
      lsPatterns * 4 * 3 * 2 + // 14 × 4 × 3 × 2 = 336
      longOnlyPatterns * 4 * 3 * 1 + // 2 × 4 × 3 × 1 = 24
      restrictedPatterns * 4 * 1 * 2; // 1 × 4 × 1 × 2 = 8
    expect(expected).toBe(368);
  });

  it("each candidate has unique name + unique cell_key (no dupes from cartesian)", () => {
    const candidates = enumerateLayerACandidates();
    const names = new Set(candidates.map((c) => c.name));
    const cellKeys = new Set(candidates.map((c) => c.cell_key));
    expect(names.size).toBe(candidates.length);
    expect(cellKeys.size).toBe(candidates.length);
  });

  it("every candidate name starts with CANDIDATE_NAME_PREFIX", () => {
    const candidates = enumerateLayerACandidates();
    expect(candidates.every((c) => c.name.startsWith(`${CANDIDATE_NAME_PREFIX} `))).toBe(true);
  });

  it("ote enumerated long-only (1 dir not 2) — historic ICT semantic", () => {
    const candidates = enumerateLayerACandidates();
    const ote = candidates.filter((c) => c.pattern === "ote");
    expect(ote).toHaveLength(4 * 3 * 1);
    expect(ote.every((c) => c.side === "long")).toBe(true);
  });

  it("H.4c additions: inside_bar + outside_bar (L+S full), doji (long-only direction-agnostic)", () => {
    const candidates = enumerateLayerACandidates();
    const inside = candidates.filter((c) => c.pattern === "inside_bar");
    const outside = candidates.filter((c) => c.pattern === "outside_bar");
    const doji = candidates.filter((c) => c.pattern === "doji");
    expect(inside).toHaveLength(4 * 3 * 2); // 24
    expect(outside).toHaveLength(4 * 3 * 2); // 24
    expect(doji).toHaveLength(4 * 3 * 1); // 12 (long-only)
    expect(doji.every((c) => c.side === "long")).toBe(true);
  });

  it("asian_range_break enumerated 4h-only (1 TF not 3) — session-aware", () => {
    const candidates = enumerateLayerACandidates();
    const arb = candidates.filter((c) => c.pattern === "asian_range_break");
    expect(arb).toHaveLength(4 * 1 * 2);
    expect(arb.every((c) => c.timeframe === "4h")).toBe(true);
  });

  it("balanced across instruments (92 candidates each — post-H.4c)", () => {
    const candidates = enumerateLayerACandidates();
    const byInst = new Map<string, number>();
    for (const c of candidates) byInst.set(c.ticker, (byInst.get(c.ticker) ?? 0) + 1);
    expect(byInst.get("XAU/USD")).toBe(92);
    expect(byInst.get("EUR/USD")).toBe(92);
    expect(byInst.get("GBP/USD")).toBe(92);
    expect(byInst.get("USD/JPY")).toBe(92);
  });

  it("each candidate carries the full canonical rule shape (passes downstream insert + validate-algo)", () => {
    const c = enumerateLayerACandidates()[0];
    expect(c.rules.entry_conditions).toHaveLength(1);
    expect(c.rules.entry_logic).toBe("all");
    expect(c.rules.exit_conditions).toEqual([]);
    expect(c.rules.stop_loss.type).toBe("swing_anchor");
    expect(c.rules.take_profit.type).toBe("rr_multiple");
    expect(c.rules.position_sizing.type).toBe("risk_per_trade");
    expect(c.rules.prop_firm).toBeDefined();
    expect(c.rules.prop_firm?.daily_loss_limit).toBe(5);
    expect(c.rules.prop_firm?.max_drawdown).toBe(10);
    expect(c.rules.timeframe).toBe(c.timeframe);
    expect(c.rules.side).toBe(c.side);
    const entry = c.rules.entry_conditions[0];
    if (entry.type === "pattern") {
      expect(entry.direction).toBe(c.side === "long" ? "bullish" : "bearish");
      expect(entry.timeframe).toBe(c.timeframe);
    }
  });

  it("gold candidates: leverage=50 + asset_class='commodity' + measured friction (CLAUDE.md)", () => {
    const gold = enumerateLayerACandidates().filter((c) => c.ticker === "XAU/USD");
    expect(gold.every((c) => c.rules.leverage === 50)).toBe(true);
    expect(gold.every((c) => c.rules.asset_class === "commodity")).toBe(true);
    expect(gold.every((c) => c.rules.prop_firm?.slippage_bps === 0.5)).toBe(true);
    expect(gold.every((c) => c.rules.prop_firm?.spread_bps === 0.4)).toBe(true);
  });

  it("forex candidates: leverage=30 + asset_class='forex' (per-instrument friction)", () => {
    const eur = enumerateLayerACandidates().filter((c) => c.ticker === "EUR/USD");
    expect(eur.every((c) => c.rules.leverage === 30)).toBe(true);
    expect(eur.every((c) => c.rules.asset_class === "forex")).toBe(true);
    expect(eur.every((c) => c.rules.prop_firm?.spread_bps === 1.0)).toBe(true);
  });
});
