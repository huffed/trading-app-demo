export const TECHNICAL_OP_LABELS: Record<string, string> = {
  less_than: "<",
  greater_than: ">",
  crosses_above: "crosses above",
  crosses_below: "crosses below",
};

export const SENTIMENT_OP_LABELS: Record<string, string> = {
  above: ">",
  below: "<",
  spike_above: "spikes above",
  spike_below: "spikes below",
};

export const STATUS_COLORS: Record<string, "default" | "secondary" | "outline"> = {
  draft: "secondary",
  active: "default",
  paused: "outline",
  archived: "secondary",
};

export const ASSET_CLASS_LABELS: Record<string, string> = {
  equity: "Stocks",
  option: "Options",
  future: "Futures",
  forex: "Forex",
  crypto: "Crypto",
};

export const RISK_LEVEL_LABELS: Record<string, string> = {
  conservative: "Conservative",
  moderate: "Moderate",
  aggressive: "Aggressive",
};

export const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  archived: "Archived",
};
