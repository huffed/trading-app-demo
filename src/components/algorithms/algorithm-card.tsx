"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { Algorithm } from "@/types/algorithm";

const statusColors: Record<string, string> = {
  draft: "secondary",
  active: "default",
  paused: "outline",
  archived: "secondary",
};

const riskColors: Record<string, string> = {
  conservative: "text-[var(--profit)]",
  moderate: "text-primary",
  aggressive: "text-[var(--loss)]",
};

export function AlgorithmCard({ algorithm }: { algorithm: Algorithm }) {
  const preview = algorithm.description.length > 120
    ? algorithm.description.slice(0, 120) + "..."
    : algorithm.description;

  return (
    <Link href={`/algorithms/${algorithm.id}`}>
      <Card className="h-full transition-colors hover:border-foreground/20 cursor-pointer">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-medium text-sm leading-tight line-clamp-2">
              {algorithm.name}
            </h3>
            <Badge
              variant={statusColors[algorithm.status] as "default" | "secondary" | "outline"}
              className="text-xs shrink-0"
            >
              {algorithm.status}
            </Badge>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline" className="text-xs">
              {algorithm.asset_class}
            </Badge>
            <span className={`text-xs font-medium ${riskColors[algorithm.risk_level]}`}>
              {algorithm.risk_level}
            </span>
          </div>
          {preview && (
            <p className="text-xs text-muted-foreground leading-relaxed">
              {preview}
            </p>
          )}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>${algorithm.capital.toLocaleString()}</span>
            <span>{new Date(algorithm.created_at).toLocaleDateString()}</span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
