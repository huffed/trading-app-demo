"use client";

import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

interface StarRatingProps {
  value: number | null;
  onChange?: (value: number) => void;
  readOnly?: boolean;
  size?: "sm" | "default";
}

export function StarRating({ value, onChange, readOnly, size = "default" }: StarRatingProps) {
  const stars = [1, 2, 3, 4, 5];
  const iconSize = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";

  return (
    <div className="flex gap-0.5">
      {stars.map((star) => {
        const filled = value != null && star <= value;
        return (
          <button
            key={star}
            type="button"
            disabled={readOnly}
            onClick={() => onChange?.(star)}
            className={cn(
              "transition-colors",
              readOnly ? "cursor-default" : "cursor-pointer hover:text-yellow-400",
              filled ? "text-yellow-400" : "text-muted-foreground/30"
            )}
          >
            <Star className={cn(iconSize, filled && "fill-yellow-400")} />
          </button>
        );
      })}
    </div>
  );
}
