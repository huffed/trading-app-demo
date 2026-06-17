/**
 * Maps the abstract axis-key/value pairs from types.ts onto concrete
 * AlgorithmRules JSON paths. Split from actions.ts to keep the action
 * file under the max-lines lint. Pure functions — no Supabase or
 * server-only dependencies — so it's importable from anywhere.
 */
import type { AlgorithmRules } from "@/types/algorithm";
import { AXES, type AxisKey } from "./types";

/** Apply a single axis value to a cloned rules object. Falls through
 *  silently when the path can't be set (e.g. SL buffer on a percentage-SL
 *  algo). The sweep caller is responsible for upstream validation that
 *  the chosen axis is compatible with the algo's SL/TP shape. */
export function applyAxis(rules: AlgorithmRules, key: AxisKey, value: number | boolean): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = rules as any;
  switch (key) {
    case "rr":
      if (r.take_profit && r.take_profit.type === "rr_multiple") r.take_profit.value = value;
      return;
    case "lookback":
      if (r.stop_loss && r.stop_loss.type === "swing_anchor") r.stop_loss.lookback = value;
      return;
    case "risk_per_trade":
      if (r.position_sizing && r.position_sizing.type === "risk_per_trade") {
        r.position_sizing.value = value;
      }
      return;
    case "sl_buffer":
      if (r.stop_loss && r.stop_loss.type === "swing_anchor") r.stop_loss.value = value;
      return;
    case "stagnant_max_bars":
      r.stagnant_exit = { ...(r.stagnant_exit ?? {}), enabled: true, max_bars: value };
      return;
    case "stagnant_min_excursion_r":
      r.stagnant_exit = { ...(r.stagnant_exit ?? {}), enabled: true, min_excursion_r: value };
      return;
    case "regime_filter":
      r.regime_filter = { ...(r.regime_filter ?? {}), enabled: value };
      return;
    case "adx_filter":
      r.adx_filter = { ...(r.adx_filter ?? {}), enabled: value };
      return;
    case "dxy_filter":
      r.dxy_filter = { ...(r.dxy_filter ?? {}), enabled: value };
      return;
  }
}

export function cloneWithAxes(
  rules: AlgorithmRules,
  xAxis: AxisKey,
  yAxis: AxisKey,
  xVal: number | boolean,
  yVal: number | boolean
): AlgorithmRules {
  const next = JSON.parse(JSON.stringify(rules)) as AlgorithmRules;
  applyAxis(next, xAxis, xVal);
  applyAxis(next, yAxis, yVal);
  return next;
}

/** Build a snapshot of every axis NOT on x/y, reading the algo's current
 *  value where determinable so the UI can show the run's full context. */
export function snapshotFixedAxes(
  rules: AlgorithmRules,
  xAxis: AxisKey,
  yAxis: AxisKey
): Partial<Record<AxisKey, number | boolean>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = rules as any;
  const out: Partial<Record<AxisKey, number | boolean>> = {};
  for (const key of Object.keys(AXES) as AxisKey[]) {
    if (key === xAxis || key === yAxis) continue;
    switch (key) {
      case "rr":
        if (r.take_profit?.type === "rr_multiple") out[key] = r.take_profit.value;
        break;
      case "lookback":
        if (r.stop_loss?.type === "swing_anchor") out[key] = r.stop_loss.lookback ?? 4;
        break;
      case "risk_per_trade":
        if (r.position_sizing?.type === "risk_per_trade") out[key] = r.position_sizing.value;
        break;
      case "sl_buffer":
        if (r.stop_loss?.type === "swing_anchor") out[key] = r.stop_loss.value;
        break;
      case "stagnant_max_bars":
        if (typeof r.stagnant_exit?.max_bars === "number") out[key] = r.stagnant_exit.max_bars;
        break;
      case "stagnant_min_excursion_r":
        if (typeof r.stagnant_exit?.min_excursion_r === "number") {
          out[key] = r.stagnant_exit.min_excursion_r;
        }
        break;
      case "regime_filter":
        out[key] = r.regime_filter?.enabled === true;
        break;
      case "adx_filter":
        out[key] = r.adx_filter?.enabled === true;
        break;
      case "dxy_filter":
        out[key] = r.dxy_filter?.enabled === true;
        break;
    }
  }
  return out;
}
