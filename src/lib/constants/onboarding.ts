export const GOAL_LABELS: Record<string, string> = {
  grow_savings: "Grow my savings steadily",
  side_income: "Earn extra income on the side",
  learn_trading: "Learn how trading works",
  replace_income: "Eventually replace my job income",
};

export const GOAL_DESCRIPTIONS: Record<string, string> = {
  grow_savings: "Low-risk strategies focused on consistent, long-term growth",
  side_income: "Balanced strategies that aim for regular returns",
  learn_trading: "Educational approach — small positions, lots of variety",
  replace_income: "Higher-risk strategies targeting significant returns",
};

export const RISK_COMFORT_LABELS: Record<string, string> = {
  sleep_well: "I want to sleep well at night",
  some_ups_downs: "I'm okay with some ups and downs",
  high_roller: "I'm comfortable with big swings",
};

export const RISK_COMFORT_DESCRIPTIONS: Record<string, string> = {
  sleep_well: "Protect what you have — slower growth, fewer surprises",
  some_ups_downs: "Balance between safety and growth — the sweet spot for most people",
  high_roller: "Higher potential gains, but your balance may drop significantly at times",
};

export const INTEREST_LABELS: Record<string, string> = {
  tech_companies: "Big tech companies",
  crypto: "Cryptocurrency",
  green_energy: "Green energy & sustainability",
  healthcare: "Healthcare & biotech",
  space_defense: "Space & defense",
  ai_ml: "AI & machine learning",
  forex: "Global currencies (Forex)",
  metals_commodities: "Gold, oil & commodities",
  ai_picks: "Let the AI decide for me",
};

export const TIME_COMMITMENT_LABELS: Record<string, string> = {
  set_forget: "Set it and forget it",
  check_weekly: "I'll check in weekly",
  daily_attention: "I want to be involved daily",
};

export const TIME_COMMITMENT_DESCRIPTIONS: Record<string, string> = {
  set_forget: "Long-term strategies — check back monthly",
  check_weekly: "Swing trading — positions last days to weeks",
  daily_attention: "Day trading — active management, faster decisions",
};

export const EXPERIENCE_LABELS: Record<string, string> = {
  total_beginner: "I'm completely new to this",
  know_basics: "I understand the basics",
  experienced: "I have trading experience",
};

export const CAPITAL_PRESETS = [100, 500, 1_000, 5_000, 10_000] as const;
