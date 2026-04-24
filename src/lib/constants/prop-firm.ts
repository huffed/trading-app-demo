import type { PropFirmRules } from "@/types/algorithm";

export type PropFirmPreset = "ftmo" | "topstep" | "funded_next" | "the5ers" | "custom";

export const PROP_FIRM_PRESETS: Record<Exclude<PropFirmPreset, "custom">, PropFirmRules> = {
  ftmo: {
    daily_loss_limit: 5,
    max_drawdown: 10,
    profit_target: 10,
    max_consecutive_losses: 5,
    consistency_rule: 40,
    slippage_bps: 10,
    commission_pct: 0.1,
  },
  topstep: {
    daily_loss_limit: 3,
    max_drawdown: 6,
    profit_target: 6,
    max_consecutive_losses: 4,
    consistency_rule: 45,
    slippage_bps: 10,
    commission_pct: 0.1,
  },
  funded_next: {
    daily_loss_limit: 5,
    max_drawdown: 10,
    profit_target: 10,
    max_consecutive_losses: 5,
    consistency_rule: 40,
    slippage_bps: 10,
    commission_pct: 0.1,
  },
  the5ers: {
    daily_loss_limit: 3,
    max_drawdown: 6,
    profit_target: 8,
    max_consecutive_losses: 4,
    consistency_rule: 45,
    slippage_bps: 15,
    commission_pct: 0.1,
  },
};

export const PROP_FIRM_LABELS: Record<PropFirmPreset, string> = {
  ftmo: "FTMO",
  topstep: "Topstep",
  funded_next: "FundedNext",
  the5ers: "The5ers",
  custom: "Custom",
};
