/**
 * E2.24.d.iv — gap-open exit fills. A bar that OPENS beyond the stop
 * (weekend/news gap) must fill at the OPEN, not the stop price. Filling
 * at the stop truncated every gap loss to exactly 1R and biased
 * worst-window Max Loss optimistic. TP stays at its limit level
 * (asymmetric-conservative).
 */
import { describe, expect, it } from "vitest";
import { pickBacktestExitPrice } from "./prop-firm-backtest";
import type { SimConfig } from "./prop-firm-backtest";

const cfg = {
  stopLoss: { type: "percentage", value: 1 },
  takeProfit: { type: "percentage", value: 3 },
  slippageBps: 0,
} as unknown as SimConfig;

// Long: entry 100, SL 99 (slDistance 1), TP 103 (tpDistance 3).
const longPos = { entryPrice: 100, side: "long" as const, slDistance: 1, tpDistance: 3 };
// Short: entry 100, SL 101, TP 97.
const shortPos = { entryPrice: 100, side: "short" as const, slDistance: 1, tpDistance: 3 };

describe("pickBacktestExitPrice — gap-open fills (E2.24.d.iv)", () => {
  it("long: bar gaps DOWN through the stop → fills at the open (worse than stop)", () => {
    // Open 97 is below the stop 99 — a gap-through. Real fill = 97, not 99.
    const d = pickBacktestExitPrice(longPos, { open: 97, high: 97.5, low: 96 }, 96.5, cfg, false);
    expect(d).toEqual({ price: 97, reason: "stop_loss_hit" });
  });

  it("long: intrabar touch (open above stop, low pierces) → fills at the stop", () => {
    const d = pickBacktestExitPrice(longPos, { open: 100.2, high: 100.5, low: 98.5 }, 99.2, cfg, false);
    expect(d).toEqual({ price: 99, reason: "stop_loss_hit" });
  });

  it("short: bar gaps UP through the stop → fills at the open (worse than stop)", () => {
    const d = pickBacktestExitPrice(shortPos, { open: 103, high: 104, low: 102.5 }, 103.5, cfg, false);
    expect(d).toEqual({ price: 103, reason: "stop_loss_hit" });
  });

  it("long: favourable TP gap still fills at the TP limit (not the better open)", () => {
    // Open 105 gapped past TP 103 — conservative model fills at 103, not 105.
    const d = pickBacktestExitPrice(longPos, { open: 105, high: 106, low: 104 }, 105.5, cfg, false);
    expect(d).toEqual({ price: 103, reason: "take_profit_hit" });
  });

  it("long: normal bar, no stop/tp touch → no exit", () => {
    const d = pickBacktestExitPrice(longPos, { open: 100.1, high: 101, low: 99.5 }, 100.5, cfg, false);
    expect(d).toBeNull();
  });

  it("long: gap-through stop takes precedence over a same-bar signal exit", () => {
    const d = pickBacktestExitPrice(longPos, { open: 97, high: 98, low: 96 }, 97.5, cfg, true);
    expect(d).toEqual({ price: 97, reason: "stop_loss_hit" });
  });
});
