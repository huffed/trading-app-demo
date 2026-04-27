/** Raw answers from the onboarding wizard — stored as-is for display in settings. */
export interface TradingProfileAnswers {
  goal: "grow_savings" | "side_income" | "learn_trading" | "replace_income";
  risk_comfort: "sleep_well" | "some_ups_downs" | "high_roller";
  capital: number;
  interests: string[];
  time_commitment: "set_forget" | "check_weekly" | "daily_attention";
  experience_level: "total_beginner" | "know_basics" | "experienced";
}

/** Derived algorithm parameters — computed deterministically from wizard answers. */
export interface DerivedTradingParams {
  asset_class: "equity" | "crypto" | "forex" | "commodity";
  risk_level: "conservative" | "moderate" | "aggressive";
  time_horizon: string;
  user_hints: string;
}

/** Full trading profile stored as JSONB on profiles table. */
export interface TradingProfile {
  answers: TradingProfileAnswers;
  derived: DerivedTradingParams;
}
