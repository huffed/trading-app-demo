import {
  GOAL_LABELS,
  INTEREST_LABELS,
  RISK_COMFORT_LABELS,
  TIME_COMMITMENT_LABELS,
  EXPERIENCE_LABELS,
} from "@/lib/constants/onboarding";
import type { DerivedTradingParams, TradingProfileAnswers } from "@/types/trading-profile";

/**
 * Pure function that maps beginner-friendly wizard answers to algorithm parameters.
 * This is the bridge between "I like tech companies" and "equity, moderate, swing".
 */
export function deriveTradingParams(answers: TradingProfileAnswers): DerivedTradingParams {
  return {
    asset_class: deriveAssetClass(answers.interests),
    risk_level: deriveRiskLevel(answers.risk_comfort),
    time_horizon: deriveTimeHorizon(answers.time_commitment),
    user_hints: buildUserHints(answers),
  };
}

function deriveAssetClass(interests: string[]): "equity" | "crypto" | "forex" | "commodity" {
  const hasCrypto = interests.includes("crypto");
  const hasForex = interests.includes("forex");
  const hasCommodity = interests.includes("metals_commodities");
  const hasStocks = interests.some((i) =>
    ["tech_companies", "green_energy", "healthcare", "space_defense", "ai_ml", "ai_picks"].includes(
      i
    )
  );

  // Single-class selections route to their dedicated asset class.
  // Mixed selections fall through to equity (the most general universe).
  if (hasCommodity && !hasCrypto && !hasForex && !hasStocks) return "commodity";
  if (hasCrypto && !hasForex && !hasCommodity && !hasStocks) return "crypto";
  if (hasForex && !hasCrypto && !hasCommodity && !hasStocks) return "forex";
  return "equity";
}

function deriveRiskLevel(comfort: string): "conservative" | "moderate" | "aggressive" {
  switch (comfort) {
    case "sleep_well":
      return "conservative";
    case "high_roller":
      return "aggressive";
    default:
      return "moderate";
  }
}

function deriveTimeHorizon(commitment: string): string {
  switch (commitment) {
    case "set_forget":
      return "long term";
    case "daily_attention":
      return "1d";
    default:
      return "swing";
  }
}

function buildUserHints(answers: TradingProfileAnswers): string {
  const parts: string[] = [];

  parts.push(`Goal: ${GOAL_LABELS[answers.goal]}.`);
  parts.push(`Risk comfort: ${RISK_COMFORT_LABELS[answers.risk_comfort]}.`);

  const interestNames = answers.interests
    .map((i) => INTEREST_LABELS[i])
    .filter(Boolean)
    .join(", ");
  if (interestNames) parts.push(`Interests: ${interestNames}.`);

  parts.push(`Time commitment: ${TIME_COMMITMENT_LABELS[answers.time_commitment]}.`);
  parts.push(`Experience: ${EXPERIENCE_LABELS[answers.experience_level]}.`);
  parts.push(`Starting capital: $${answers.capital.toLocaleString()}.`);

  return parts.join(" ");
}
