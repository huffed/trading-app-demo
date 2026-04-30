import { describe, expect, it } from "vitest";
import { enumerateCandidates } from "./grid";

const INPUT = { capital: 100000, monthly_target_pct: 10 };

describe("enumerateCandidates — gold template emission", () => {
  it("emits all five gold templates", () => {
    const names = new Set(enumerateCandidates(INPUT).map((c) => c.template_name));
    expect(names.has("gold_killzone_sweep")).toBe(true);
    expect(names.has("gold_silver_bullet")).toBe(true);
    expect(names.has("gold_asian_breakout")).toBe(true);
    expect(names.has("gold_h4_trend_pullback")).toBe(true);
    expect(names.has("gold_d1_sma_trend_filter")).toBe(true);
  });

  it("does NOT include gold_news_fade — deferred until backtest news-replay exists", () => {
    const names = new Set(enumerateCandidates(INPUT).map((c) => c.template_name));
    expect(names.has("gold_news_fade")).toBe(false);
  });

  it("preserves all forex templates by name", () => {
    const forexNames = new Set(
      enumerateCandidates(INPUT)
        .filter((c) => !c.template_name.startsWith("gold_"))
        .map((c) => c.template_name)
    );
    const expected = [
      "momentum_solo",
      "momentum_with_bias",
      "multi_tf_engulf_bos",
      "multi_tf_pin_fvg",
      "multi_tf_confluence_5",
      "ict_sweep_fvg_combo",
      "ict_bos_orderblock",
      "rsi_oversold_bounce",
      "rsi_overbought_fade",
      "sma_crossover_trend",
      "ema_macd_signal",
      "bollinger_lower_bounce",
      "macd_zero_cross",
    ];
    for (const name of expected) {
      expect(forexNames.has(name)).toBe(true);
    }
  });
});

describe("enumerateCandidates — gold vs forex rule shape", () => {
  it("gold candidates have asset_class=commodity and leverage=50", () => {
    const goldCandidates = enumerateCandidates(INPUT).filter((c) =>
      c.template_name.startsWith("gold_")
    );
    expect(goldCandidates.length).toBeGreaterThan(0);
    for (const c of goldCandidates) {
      expect(c.rules.asset_class).toBe("commodity");
      expect(c.rules.leverage).toBe(50);
    }
  });

  it("forex candidates retain asset_class=forex and leverage=30", () => {
    const forexCandidates = enumerateCandidates(INPUT).filter(
      (c) => !c.template_name.startsWith("gold_")
    );
    for (const c of forexCandidates) {
      expect(c.rules.asset_class).toBe("forex");
      expect(c.rules.leverage).toBe(30);
    }
  });
});

describe("enumerateCandidates — stagnant_exit by timeframe", () => {
  it("15m candidates use tightened stagnant_exit (max_bars=16, min_pnl_r=-0.3)", () => {
    const candidates15m = enumerateCandidates(INPUT).filter((c) => c.rules.timeframe === "15m");
    expect(candidates15m.length).toBeGreaterThan(0);
    for (const c of candidates15m) {
      expect(c.rules.stagnant_exit?.max_bars).toBe(16);
      expect(c.rules.stagnant_exit?.min_pnl_r).toBe(-0.3);
    }
  });

  it("non-15m candidates retain default stagnant_exit (max_bars=48, min_pnl_r=-0.5)", () => {
    const candidatesOther = enumerateCandidates(INPUT).filter((c) => c.rules.timeframe !== "15m");
    expect(candidatesOther.length).toBeGreaterThan(0);
    for (const c of candidatesOther) {
      expect(c.rules.stagnant_exit?.max_bars).toBe(48);
      expect(c.rules.stagnant_exit?.min_pnl_r).toBe(-0.5);
    }
  });
});

describe("enumerateCandidates — 3D search (template × params × exit variants)", () => {
  it("emits multiple exit variants per (template × param) combo", () => {
    const candidates = enumerateCandidates(INPUT);
    const ictBosCandidates = candidates.filter(
      (c) => c.template_name === "ict_bos_orderblock" && c.rules.timeframe === "1h"
    );
    expect(ictBosCandidates.length).toBeGreaterThan(1);
  });

  it("no_exit variant has empty exit_conditions", () => {
    const c = enumerateCandidates(INPUT).find(
      (cand) =>
        cand.template_name === "ict_bos_orderblock" &&
        !cand.label.includes("__signal_flip") &&
        !cand.label.includes("__daily_bias_flip")
    );
    expect(c).toBeDefined();
    expect(c!.rules.exit_conditions).toHaveLength(0);
  });

  it("signal_flip variant has bearish bos exit for ict_bos_orderblock long entry", () => {
    const c = enumerateCandidates(INPUT).find((cand) =>
      cand.label.startsWith("ict_bos_orderblock") && cand.label.endsWith("__signal_flip")
    );
    expect(c).toBeDefined();
    expect(c!.rules.exit_conditions.length).toBeGreaterThan(0);
    const exit = c!.rules.exit_conditions[0];
    expect(exit.type).toBe("pattern");
    if (exit.type === "pattern") {
      expect(exit.pattern).toBe("bos");
      expect(exit.direction).toBe("bearish");
    }
  });

  it("daily_bias_flip variant has bearish daily_bias exit on long-side templates", () => {
    const c = enumerateCandidates(INPUT).find((cand) =>
      cand.label.startsWith("momentum_solo") && cand.label.endsWith("__daily_bias_flip")
    );
    expect(c).toBeDefined();
    const exit = c!.rules.exit_conditions[0];
    expect(exit.type).toBe("pattern");
    if (exit.type === "pattern") {
      expect(exit.pattern).toBe("daily_bias");
      expect(exit.direction).toBe("bearish");
      expect(exit.timeframe).toBe("1d");
    }
  });

  it("AUTO-side templates skip signal_flip and daily_bias_flip variants", () => {
    const candidates = enumerateCandidates(INPUT);
    const smaCrossover = candidates.filter(
      (c) => c.template_name === "sma_crossover_trend"
    );
    expect(smaCrossover.length).toBeGreaterThan(0);
    for (const c of smaCrossover) {
      expect(c.label.includes("__signal_flip")).toBe(false);
      expect(c.label.includes("__daily_bias_flip")).toBe(false);
    }
  });

  it("rsi_overbought_fade short-side gets RSI > 80 signal_flip exit", () => {
    const c = enumerateCandidates(INPUT).find((cand) =>
      cand.label.startsWith("rsi_overbought_fade") && cand.label.endsWith("__signal_flip")
    );
    expect(c).toBeDefined();
    expect(c!.rules.side).toBe("short");
    const exit = c!.rules.exit_conditions[0];
    expect(exit.type).toBe("technical");
    if (exit.type === "technical") {
      expect(exit.indicator).toBe("RSI");
      expect(exit.operator).toBe("greater_than");
      expect(exit.value).toBe(80);
    }
  });
});

describe("enumerateCandidates — 4D parameter sweeps", () => {
  it("emits rsi_overbought_fade variants for RSI thresholds 65/70/75/80", () => {
    const candidates = enumerateCandidates(INPUT);
    const labels = candidates.map((c) => c.label);
    // Default variant has no suffix (RSI 70).
    expect(labels.some((l) => l === "rsi_overbought_fade__15m_normal_3R")).toBe(true);
    // Sweep variants: rsi65, rsi75, rsi80.
    expect(labels.some((l) => l.startsWith("rsi_overbought_fade__rsi65__"))).toBe(true);
    expect(labels.some((l) => l.startsWith("rsi_overbought_fade__rsi75__"))).toBe(true);
    expect(labels.some((l) => l.startsWith("rsi_overbought_fade__rsi80__"))).toBe(true);
  });

  it("RSI 65 variant has RSI > 65 entry condition", () => {
    const c = enumerateCandidates(INPUT).find(
      (cand) => cand.label.startsWith("rsi_overbought_fade__rsi65__") && !cand.label.includes("signal_flip") && !cand.label.includes("daily_bias_flip")
    );
    expect(c).toBeDefined();
    const cond = c!.rules.entry_conditions[0];
    expect(cond.type).toBe("technical");
    if (cond.type === "technical") {
      expect(cond.indicator).toBe("RSI");
      expect(cond.value).toBe(65);
    }
  });

  it("emits momentum_solo lookback variants (lb2, lb5, lb8)", () => {
    const labels = enumerateCandidates(INPUT).map((c) => c.label);
    expect(labels.some((l) => l.startsWith("momentum_solo__lb2__"))).toBe(true);
    expect(labels.some((l) => l.startsWith("momentum_solo__lb5__"))).toBe(true);
    expect(labels.some((l) => l.startsWith("momentum_solo__lb8__"))).toBe(true);
  });

  it("momentum lookback variant carries through to entry condition", () => {
    const c = enumerateCandidates(INPUT).find(
      (cand) => cand.label.startsWith("momentum_solo__lb5__") && !cand.label.includes("__signal_flip") && !cand.label.includes("__daily_bias_flip")
    );
    expect(c).toBeDefined();
    const cond = c!.rules.entry_conditions[0];
    expect(cond.type).toBe("pattern");
    if (cond.type === "pattern") {
      expect(cond.pattern).toBe("momentum");
      expect(cond.lookback).toBe(5);
    }
  });

  it("template_name stays the base name even for parameter variants (preserves exit-variant lookup)", () => {
    const c = enumerateCandidates(INPUT).find((cand) =>
      cand.label.startsWith("rsi_overbought_fade__rsi65__")
    );
    expect(c).toBeDefined();
    // template_name lets exit-variants.ts match by base name regardless of param suffix.
    expect(c!.template_name).toBe("rsi_overbought_fade");
  });
});

describe("enumerateCandidates — gold template condition shapes", () => {
  it("gold_killzone_sweep emits 4 conditions on 15m with logic=all", () => {
    const c = enumerateCandidates(INPUT).find(
      (cand) => cand.template_name === "gold_killzone_sweep"
    );
    expect(c).toBeDefined();
    expect(c!.rules.timeframe).toBe("15m");
    expect(c!.rules.entry_conditions).toHaveLength(4);
    expect(c!.rules.entry_logic).toBe("all");
  });

  it("gold_d1_sma_trend_filter uses SMA200 on 1d", () => {
    const c = enumerateCandidates(INPUT).find(
      (cand) => cand.template_name === "gold_d1_sma_trend_filter"
    );
    expect(c).toBeDefined();
    expect(c!.rules.timeframe).toBe("1d");
    const cond = c!.rules.entry_conditions[0];
    expect(cond.type).toBe("technical");
    if (cond.type === "technical") {
      expect(cond.indicator).toBe("SMA200");
    }
  });

});
