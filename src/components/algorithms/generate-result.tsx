"use client";

import { Loader2, Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

interface GenerateResultProps {
  text: string;
  isStreaming: boolean;
}

export function GenerateResult({ text, isStreaming }: GenerateResultProps) {
  if (!text && !isStreaming) return null;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">AI Strategy</span>
        </div>
        {isStreaming && !text && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Designing your algorithm...
          </div>
        )}
        {text && <div className="whitespace-pre-wrap text-sm leading-relaxed">{text}</div>}
        {isStreaming && text && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Generating...
          </div>
        )}
      </CardContent>
    </Card>
  );
}
