/**
 * Snapshot of an algorithm's live FTMO-compliance state. Read-only,
 * derived entirely from existing tables (paper_positions, activity_log,
 * algorithms.rules.prop_firm). No schema changes.
 */

export interface ComplianceGauge {
  /** Current value as a positive number (e.g. 1.4 means 1.4% used). */
  value_pct: number;
  /** The relevant FTMO/strategy threshold the value is racing toward. */
  threshold_pct: number;
  /** Display label for the gauge. */
  label: string;
  /**
   * "ok" — comfortably under threshold
   * "warn" — within 80% of threshold
   * "breach" — at/over threshold
   */
  state: "ok" | "warn" | "breach";
}

export interface DivergenceState {
  /** Number of broker-mirrored entries with a recorded fill price. */
  samples: number;
  /** Window size required before the kill switch arms (from rules). */
  required_samples: number;
  /** Current rolling-mean abs divergence in bps (NaN < required_samples). */
  avg_bps: number;
  /** Threshold that would trip the kill switch. */
  threshold_bps: number;
  /** Whether the kill switch is currently active and tripped. */
  is_armed: boolean;
}

export interface HaltEvent {
  event_type: "daily_loss_halt" | "divergence_halt" | string;
  created_at: string;
  details: Record<string, unknown>;
}

export interface FtmoCompliance {
  /** True when the algo has prop_firm rules — the gauges only make sense then. */
  has_prop_firm: boolean;
  daily_pnl: ComplianceGauge | null;
  drawdown: ComplianceGauge | null;
  profit_target: ComplianceGauge | null;
  divergence: DivergenceState | null;
  /** Last 5 halt events, newest first. */
  recent_halts: HaltEvent[];
}
