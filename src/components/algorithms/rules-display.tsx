"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SENTIMENT_OP_LABELS, TECHNICAL_OP_LABELS } from "@/lib/constants/algorithm";
import {
  isTechnicalCondition,
  type AlgorithmRules,
  type EntryCondition,
  type ExitCondition,
} from "@/types/algorithm";

function ConditionList({
  title,
  conditions,
}: {
  title: string;
  conditions: (EntryCondition | ExitCondition)[];
}) {
  if (!conditions || conditions.length === 0) {
    return null;
  }

  return (
    <div className="space-y-1">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      {conditions.map((c, i) =>
        isTechnicalCondition(c) ? (
          <div key={i} className="flex items-center gap-1.5 text-sm">
            <Badge variant="outline" className="text-xs">
              {c.indicator}
            </Badge>
            <span className="text-muted-foreground">
              {TECHNICAL_OP_LABELS[c.operator] ?? c.operator}
            </span>
            <span className="font-medium">{c.value}</span>
            <span className="text-xs text-muted-foreground">({c.timeframe})</span>
          </div>
        ) : (
          <div key={i} className="flex flex-wrap items-center gap-1.5 text-sm">
            <Badge className="text-xs bg-primary/10 text-primary">sentiment</Badge>
            <span className="text-muted-foreground">{c.metric}</span>
            <span className="text-muted-foreground">
              {SENTIMENT_OP_LABELS[c.operator] ?? c.operator}
            </span>
            <span className="font-medium">{c.threshold}</span>
            {c.topics?.map((t) => (
              <Badge key={t} variant="outline" className="text-xs">
                {t}
              </Badge>
            ))}
          </div>
        )
      )}
    </div>
  );
}

function RiskParams({ rules }: { rules: AlgorithmRules }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <h4 className="text-xs font-medium text-muted-foreground">Stop Loss</h4>
        <p className="text-sm">
          {rules.stop_loss?.value}% ({rules.stop_loss?.type})
        </p>
      </div>
      <div className="space-y-1">
        <h4 className="text-xs font-medium text-muted-foreground">Take Profit</h4>
        <p className="text-sm">
          {rules.take_profit?.value}% ({rules.take_profit?.type})
        </p>
      </div>
      <div className="space-y-1">
        <h4 className="text-xs font-medium text-muted-foreground">Position Size</h4>
        <p className="text-sm">{rules.position_sizing?.value}% of capital</p>
      </div>
      <div className="space-y-1">
        <h4 className="text-xs font-medium text-muted-foreground">Max Positions</h4>
        <p className="text-sm">{rules.max_positions}</p>
      </div>
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
        <ConditionList title="Entry Conditions" conditions={rules.entry_conditions} />
        <ConditionList title="Exit Conditions" conditions={rules.exit_conditions} />
        <RiskParams rules={rules} />
      </CardContent>
    </Card>
  );
}
