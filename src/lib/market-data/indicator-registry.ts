/**
 * Lookup + cached evaluation for the technical indicators used by the
 * backtest engine and live scan.
 */
import { bollingerBands, ema, macd, rsi, sma } from "./indicators";

export type Cache = Map<string, (number | null)[]>;

const INDICATOR_REGISTRY: Record<string, (closes: number[]) => (number | null)[]> = {
  rsi: (c) => rsi(c),
  sma: (c) => sma(c, 20),
  sma20: (c) => sma(c, 20),
  sma50: (c) => sma(c, 50),
  ema: (c) => ema(c, 12),
  ema12: (c) => ema(c, 12),
  ema26: (c) => ema(c, 26),
  macd: (c) => macd(c),
  bollingerbands_upper: (c) => bollingerBands(c).upper,
  bollingerbands_lower: (c) => bollingerBands(c).lower,
};

function computeIndicator(closes: number[], name: string): (number | null)[] {
  const fn = INDICATOR_REGISTRY[name.toLowerCase()];
  if (!fn) {
    console.warn(`[backtest] Unsupported indicator "${name}" — condition will never trigger`);
    return closes.map(() => null);
  }
  return fn(closes);
}

export function getValues(name: string, cache: Cache, closes: number[]): (number | null)[] {
  if (!cache.has(name)) cache.set(name, computeIndicator(closes, name));
  const vals = cache.get(name);
  if (!vals) throw new Error(`Indicator "${name}" failed to compute`);
  return vals;
}

export function isPriceIndicator(name: string): boolean {
  const l = name.toLowerCase();
  return l.startsWith("sma") || l.startsWith("ema") || l.startsWith("bollinger");
}
