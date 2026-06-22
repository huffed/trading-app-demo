/**
 * Multi-TF + ICT entry-condition builders — shared by multiple template
 * definitions in grid-templates.ts. Extracted on 2026-06-22 (CB.H1 pass 19)
 * so the template definitions file stays focused on the catalog itself.
 */
import type { EntryLogic, PatternCondition } from "@/types/algorithm";

export function buildMultiTfEngulfBos(tf: string): { entry: PatternCondition[]; logic: EntryLogic } {
  return {
    entry: [
      { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "1d" },
      { type: "pattern", pattern: "engulfing", direction: "bullish", timeframe: "4h" },
      { type: "pattern", pattern: "bos", lookback: 5, direction: "bullish", timeframe: tf },
    ],
    logic: { type: "n_of_m", n: 2 },
  };
}

export function buildMultiTfPinFvg(tf: string): { entry: PatternCondition[]; logic: EntryLogic } {
  return {
    entry: [
      { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "1d" },
      { type: "pattern", pattern: "pin_bar", direction: "bullish", timeframe: "4h" },
      { type: "pattern", pattern: "fvg", direction: "bullish", timeframe: tf },
    ],
    logic: { type: "n_of_m", n: 2 },
  };
}

export function buildMultiTfConfluence5(tf: string): { entry: PatternCondition[]; logic: EntryLogic } {
  return {
    entry: [
      { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "1d" },
      { type: "pattern", pattern: "engulfing", direction: "bullish", timeframe: "4h" },
      { type: "pattern", pattern: "pin_bar", direction: "bullish", timeframe: "4h" },
      { type: "pattern", pattern: "bos", lookback: 5, direction: "bullish", timeframe: tf },
      { type: "pattern", pattern: "liquidity_sweep", lookback: 5, direction: "bullish", timeframe: tf },
    ],
    logic: { type: "n_of_m", n: 3 },
  };
}

export function buildIctSweepFvg(tf: string): { entry: PatternCondition[]; logic: EntryLogic } {
  return {
    entry: [
      { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "1d" },
      { type: "pattern", pattern: "liquidity_sweep", lookback: 5, direction: "bullish", timeframe: tf },
      { type: "pattern", pattern: "fvg", direction: "bullish", timeframe: tf },
      { type: "pattern", pattern: "ifvg", lookback: 5, direction: "bullish", timeframe: tf },
      { type: "pattern", pattern: "liquidity_sweep", lookback: 5, direction: "bullish", timeframe: "4h" },
    ],
    logic: { type: "n_of_m", n: 2 },
  };
}

export function buildIctBosOrderBlock(tf: string): { entry: PatternCondition[]; logic: EntryLogic } {
  return {
    entry: [
      { type: "pattern", pattern: "daily_bias", direction: "bullish", ma_period: 20, timeframe: "1d" },
      { type: "pattern", pattern: "bos", direction: "bullish", timeframe: tf },
      { type: "pattern", pattern: "order_block", direction: "bullish", timeframe: tf },
    ],
    logic: { type: "n_of_m", n: 2 },
  };
}
