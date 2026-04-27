"use client";

import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Newspaper,
  ShieldAlert,
  Target,
  TrendingUp,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getQuantityUnit } from "@/lib/constants/markets";
import {
  isTechnicalCondition,
  type AlgorithmRules,
  type EntryCondition,
  type ExitCondition,
  type SentimentCondition,
  type TechnicalCondition,
} from "@/types/algorithm";

// ---- Human-readable condition formatting ----

const INDICATOR_NAMES: Record<string, string> = {
  rsi: "RSI (14)",
  sma: "SMA 20",
  sma20: "SMA 20",
  sma50: "SMA 50",
  ema: "EMA 12",
  ema12: "EMA 12",
  ema26: "EMA 26",
  macd: "MACD",
  bollingerbands_upper: "Bollinger Upper",
  bollingerbands_lower: "Bollinger Lower",
};

const SENTIMENT_METRIC_NAMES: Record<string, string> = {
  overall_sentiment: "Overall sentiment",
  article_count: "Article count",
  topic_buzz: "Topic buzz",
};

function isPriceIndicator(name: string): boolean {
  const l = name.toLowerCase();
  return l.startsWith("sma") || l.startsWith("ema") || l.startsWith("bollinger");
}

function formatTechnicalCondition(c: TechnicalCondition): string {
  const name = INDICATOR_NAMES[c.indicator.toLowerCase()] ?? c.indicator;

  // value=0 on price indicators means crossover vs price (or EMA12 vs EMA26)
  if (c.value === 0 && isPriceIndicator(c.indicator)) {
    if (c.indicator.toLowerCase() === "ema12") {
      switch (c.operator) {
        case "crosses_above":
          return "EMA 12 crosses above EMA 26 (bullish MACD crossover)";
        case "crosses_below":
          return "EMA 12 crosses below EMA 26 (bearish MACD crossover)";
        case "greater_than":
          return "EMA 12 is above EMA 26";
        case "less_than":
          return "EMA 12 is below EMA 26";
      }
    }
    switch (c.operator) {
      case "crosses_above":
        return `Price crosses above ${name}`;
      case "crosses_below":
        return `Price crosses below ${name}`;
      case "greater_than":
        return `Price is above ${name}`;
      case "less_than":
        return `Price is below ${name}`;
    }
  }

  switch (c.operator) {
    case "less_than":
      return `${name} is below ${c.value}`;
    case "greater_than":
      return `${name} is above ${c.value}`;
    case "crosses_above":
      return `${name} crosses above ${c.value}`;
    case "crosses_below":
      return `${name} crosses below ${c.value}`;
    default:
      return `${name} ${c.operator} ${c.value}`;
  }
}

function formatSentimentCondition(c: SentimentCondition): string {
  const metric = SENTIMENT_METRIC_NAMES[c.metric] ?? c.metric;
  switch (c.operator) {
    case "above":
      return `${metric} above ${c.threshold}`;
    case "below":
      return `${metric} below ${c.threshold}`;
    case "spike_above":
      return `${metric} spikes above ${c.threshold}`;
    case "spike_below":
      return `${metric} drops below ${c.threshold}`;
    default:
      return `${metric} ${c.operator} ${c.threshold}`;
  }
}

// ---- Components ----

function ConditionItem({ condition }: { condition: EntryCondition | ExitCondition }) {
  if (isTechnicalCondition(condition)) {
    return (
      <div className="flex items-start gap-2.5 rounded-md border p-2.5">
        <BarChart3 className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
        <div>
          <p className="text-sm">{formatTechnicalCondition(condition)}</p>
          <p className="text-xs text-muted-foreground">{condition.timeframe} timeframe</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2.5 rounded-md border p-2.5">
      <Newspaper className="mt-0.5 h-4 w-4 shrink-0 text-purple-500" />
      <div>
        <p className="text-sm">{formatSentimentCondition(condition)}</p>
        {condition.topics && condition.topics.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {condition.topics.map((t) => (
              <Badge key={t} variant="secondary" className="text-xs">
                {t}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function formatEntryLogic(
  logic: AlgorithmRules["entry_logic"],
  conditionCount: number
): string {
  if (!logic || logic === "all") return `all ${conditionCount} required`;
  if (logic === "any") return "any one fires";
  return `${logic.n} of ${conditionCount} required`;
}

function ConditionSection({
  title,
  icon,
  conditions,
  logic,
}: {
  title: string;
  icon: React.ReactNode;
  conditions: (EntryCondition | ExitCondition)[];
  logic?: AlgorithmRules["entry_logic"];
}) {
  if (!conditions || conditions.length === 0) {
    return null;
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {icon}
          {title}
        </h4>
        {logic && conditions.length > 1 && (
          <span className="text-xs text-muted-foreground">
            {formatEntryLogic(logic, conditions.length)}
          </span>
        )}
      </div>
      {conditions.map((c, i) => (
        <ConditionItem key={i} condition={c} />
      ))}
    </div>
  );
}

function formatPositionSizing(rules: AlgorithmRules): string {
  switch (rules.position_sizing.type) {
    case "percentage_of_capital":
      return `${rules.position_sizing.value}% of capital per trade`;
    case "fixed_amount":
      return `$${rules.position_sizing.value.toLocaleString()} per trade`;
    case "fixed_quantity": {
      const unit = getQuantityUnit(rules.asset_class);
      return `${rules.position_sizing.value.toLocaleString()} ${unit} per trade`;
    }
    case "lots": {
      const lots = rules.position_sizing.value;
      const noun = lots === 1 ? "lot" : "lots";
      return `${lots} ${noun} per trade`;
    }
    default:
      return `${rules.position_sizing.value}`;
  }
}

function RiskParams({ rules }: { rules: AlgorithmRules }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex items-center gap-2.5 rounded-md border p-2.5">
        <ShieldAlert className="h-4 w-4 shrink-0 text-[var(--loss)]" />
        <div>
          <p className="text-xs text-muted-foreground">Stop Loss</p>
          <p className="text-sm font-medium">{rules.stop_loss.value}%</p>
        </div>
      </div>
      <div className="flex items-center gap-2.5 rounded-md border p-2.5">
        <Target className="h-4 w-4 shrink-0 text-[var(--profit)]" />
        <div>
          <p className="text-xs text-muted-foreground">Take Profit</p>
          <p className="text-sm font-medium">{rules.take_profit.value}%</p>
        </div>
      </div>
      <div className="flex items-center gap-2.5 rounded-md border p-2.5">
        <TrendingUp className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div>
          <p className="text-xs text-muted-foreground">Position Size</p>
          <p className="text-sm font-medium">
            {formatPositionSizing(rules)}
            {rules.position_sizing.type === "lots" && rules.leverage ? (
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                (1:{rules.leverage} leverage)
              </span>
            ) : null}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2.5 rounded-md border p-2.5">
        <BarChart3 className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div>
          <p className="text-xs text-muted-foreground">Max Positions</p>
          <p className="text-sm font-medium">
            {rules.max_positions}
            {rules.max_per_ticker && rules.max_per_ticker > 1 ? (
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                ({rules.max_per_ticker} per pair)
              </span>
            ) : null}
          </p>
        </div>
      </div>
      {rules.news_veto?.enabled && (
        <div className="flex items-center gap-2.5 rounded-md border p-2.5 sm:col-span-2">
          <Newspaper className="h-4 w-4 shrink-0 text-purple-500" />
          <div>
            <p className="text-xs text-muted-foreground">News Protection</p>
            <p className="text-sm font-medium">
              Block {rules.news_veto.min_impact}+ events:{" "}
              -{rules.news_veto.block_minutes_before}m to +{rules.news_veto.block_minutes_after}m
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export function RulesDisplay({ rules }: { rules: AlgorithmRules }) {
  if (!rules.entry_conditions) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          No rules generated yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Trading Rules</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ConditionSection
          title="Entry Conditions"
          icon={<ArrowUp className="h-3 w-3" />}
          conditions={rules.entry_conditions}
          logic={rules.entry_logic}
        />
        <ConditionSection
          title="Exit Conditions"
          icon={<ArrowDown className="h-3 w-3" />}
          conditions={rules.exit_conditions}
        />
        <div>
          <h4 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <ShieldAlert className="h-3 w-3" />
            Risk Management
          </h4>
          <RiskParams rules={rules} />
        </div>
      </CardContent>
    </Card>
  );
}
