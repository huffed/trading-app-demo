"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  ASSET_CLASS_LABELS,
  RISK_LEVEL_COLORS,
  RISK_LEVEL_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
} from "@/lib/constants/algorithm";
import type { Algorithm } from "@/types/algorithm";

export function AlgorithmCard({ algorithm }: { algorithm: Algorithm }) {
  const desc = algorithm.description ?? "";
  const preview = desc.length > 120 ? desc.slice(0, 120) + "..." : desc;

  return (
    <Link href={`/algorithms/${algorithm.id}`}>
      <Card className="h-full transition-colors hover:border-foreground/20 cursor-pointer">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-medium text-sm leading-tight line-clamp-2">{algorithm.name}</h3>
            <Badge
              variant={STATUS_COLORS[algorithm.status] ?? "secondary"}
              className="text-xs shrink-0"
            >
              {STATUS_LABELS[algorithm.status] ?? algorithm.status}
            </Badge>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline" className="text-xs">
              {ASSET_CLASS_LABELS[algorithm.asset_class] ?? algorithm.asset_class}
            </Badge>
            <span className={`text-xs font-medium ${RISK_LEVEL_COLORS[algorithm.risk_level]}`}>
              {RISK_LEVEL_LABELS[algorithm.risk_level] ?? algorithm.risk_level}
            </span>
          </div>
          {preview && <p className="text-xs text-muted-foreground leading-relaxed">{preview}</p>}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>${algorithm.capital.toLocaleString()}</span>
            <span>{new Date(algorithm.created_at).toLocaleDateString()}</span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
