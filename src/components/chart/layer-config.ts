/**
 * Layer toggle configuration for the chart. Each boolean turns one
 * visual element on or off. Defaults reflect a sensible trader's
 * working setup: 20-period SMA + entry/exit markers visible by default,
 * everything else off until requested.
 */
export interface LayerConfig {
  // Moving averages (price-pane overlays)
  sma20: boolean;
  sma50: boolean;
  sma200: boolean;
  ema12: boolean;
  ema26: boolean;
  // Bollinger Bands (price-pane overlay)
  bollinger: boolean;
  // Oscillator panes
  rsi: boolean;
  macd: boolean;
  // ICT/SMC pattern markers
  fvg: boolean;
  ifvg: boolean;
  bos: boolean;
  sweep: boolean;
  order_block: boolean;
  choch: boolean;
  daily_bias: boolean;
  // Trade markers (operator's paper-position activity)
  trade_entries: boolean;
  trade_exits: boolean;
}

export const DEFAULT_LAYERS: LayerConfig = {
  sma20: true,
  sma50: false,
  sma200: false,
  ema12: false,
  ema26: false,
  bollinger: false,
  rsi: false,
  macd: false,
  fvg: false,
  ifvg: false,
  bos: false,
  sweep: false,
  order_block: false,
  choch: false,
  daily_bias: true,
  trade_entries: true,
  trade_exits: true,
};

/** Display metadata for the toggle panel — label + group + a swatch color
 *  so the panel can preview each layer's appearance. */
export const LAYER_META: Record<keyof LayerConfig, { label: string; group: LayerGroup; color: string }> = {
  sma20: { label: "SMA 20", group: "indicators", color: "rgba(120,180,230,0.95)" },
  sma50: { label: "SMA 50", group: "indicators", color: "rgba(200,170,90,0.95)" },
  sma200: { label: "SMA 200", group: "indicators", color: "rgba(160,90,200,0.95)" },
  ema12: { label: "EMA 12", group: "indicators", color: "rgba(90,200,160,0.95)" },
  ema26: { label: "EMA 26", group: "indicators", color: "rgba(230,140,90,0.95)" },
  bollinger: { label: "Bollinger Bands", group: "indicators", color: "rgba(180,180,220,0.6)" },
  rsi: { label: "RSI (pane)", group: "oscillators", color: "rgba(120,180,230,0.95)" },
  macd: { label: "MACD (pane)", group: "oscillators", color: "rgba(74,196,142,0.95)" },
  fvg: { label: "FVG", group: "patterns", color: "rgba(74,196,142,0.95)" },
  ifvg: { label: "Inverse FVG", group: "patterns", color: "rgba(232,90,90,0.95)" },
  bos: { label: "Break of Structure", group: "patterns", color: "rgba(200,170,90,0.95)" },
  sweep: { label: "Liquidity Sweep", group: "patterns", color: "rgba(160,90,200,0.95)" },
  order_block: { label: "Order Block", group: "patterns", color: "rgba(120,150,220,0.95)" },
  choch: { label: "ChoCh", group: "patterns", color: "rgba(230,140,90,0.95)" },
  daily_bias: { label: "Daily Bias", group: "patterns", color: "rgba(180,180,220,0.95)" },
  trade_entries: { label: "Trade entries", group: "trades", color: "rgba(74,196,142,0.95)" },
  trade_exits: { label: "Trade exits", group: "trades", color: "rgba(120,180,230,0.95)" },
};

export type LayerGroup = "indicators" | "oscillators" | "patterns" | "trades";

export const GROUP_LABELS: Record<LayerGroup, string> = {
  indicators: "Indicators",
  oscillators: "Oscillator panes",
  patterns: "ICT / SMC patterns",
  trades: "Trade markers",
};
