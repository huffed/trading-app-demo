"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { tourSteps } from "@/lib/content/tour-steps";
import { cn } from "@/lib/utils";

interface TourOverlayProps {
  onComplete: () => void;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function getTargetRect(selector: string | undefined): Rect | null {
  if (typeof window === "undefined" || !selector) return null;
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

function ProgressDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex gap-1.5">
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "h-1.5 rounded-full transition-all",
            i === current ? "w-4 bg-primary" : "w-1.5 bg-muted-foreground/30"
          )}
        />
      ))}
    </div>
  );
}

function TourCard({
  step,
  current,
  total,
  onPrev,
  onNext,
  onSkip,
  style,
}: {
  step: (typeof tourSteps)[number];
  current: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onSkip: () => void;
  style?: React.CSSProperties;
}) {
  const isFirst = current === 0;
  const isLast = current === total - 1;

  return (
    <div
      className="fixed z-[60] w-80 rounded-xl bg-popover p-4 shadow-xl ring-1 ring-foreground/10"
      style={style}
    >
      <div className="space-y-2">
        <div className="text-2xl">{step.icon}</div>
        <h3 className="font-medium text-sm">{step.title}</h3>
        <p className="text-xs text-muted-foreground leading-relaxed">
          {step.description}
        </p>
      </div>
      <div className="mt-4 flex items-center justify-between">
        <ProgressDots current={current} total={total} />
        <div className="flex gap-1.5">
          {isFirst && (
            <Button variant="ghost" size="xs" onClick={onSkip}>
              Skip
            </Button>
          )}
          {!isFirst && (
            <Button variant="ghost" size="xs" onClick={onPrev}>
              <ChevronLeft className="mr-0.5 h-3 w-3" />
              Back
            </Button>
          )}
          <Button size="xs" onClick={isLast ? onSkip : onNext}>
            {isLast ? "Get Started" : "Next"}
            {!isLast && <ChevronRight className="ml-0.5 h-3 w-3" />}
          </Button>
        </div>
      </div>
    </div>
  );
}

function computeCardPosition(rect: Rect | null): React.CSSProperties {
  if (!rect) {
    return { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };
  }
  const padding = 12;
  const cardWidth = 320;

  // Position to the right of the target if space, otherwise below
  const rightSpace = window.innerWidth - (rect.left + rect.width + padding);
  if (rightSpace >= cardWidth + padding) {
    return {
      top: Math.max(padding, rect.top),
      left: rect.left + rect.width + padding,
    };
  }

  return {
    top: rect.top + rect.height + padding,
    left: Math.min(rect.left, window.innerWidth - cardWidth - padding),
  };
}

export function TourOverlay({ onComplete }: TourOverlayProps) {
  const [step, setStep] = useState(0);
  const current = tourSteps[step];
  const rect = getTargetRect(current.target);
  const cardStyle = computeCardPosition(rect);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/60 transition-opacity"
        onClick={onComplete}
      />

      {/* Spotlight cutout */}
      {rect && (
        <div
          className="fixed z-[55] rounded-lg ring-2 ring-primary shadow-[0_0_0_9999px_rgba(0,0,0,0.6)]"
          style={{
            top: rect.top - 4,
            left: rect.left - 4,
            width: rect.width + 8,
            height: rect.height + 8,
          }}
        />
      )}

      <TourCard
        step={current}
        current={step}
        total={tourSteps.length}
        onPrev={() => setStep(step - 1)}
        onNext={() => setStep(step + 1)}
        onSkip={onComplete}
        style={cardStyle}
      />
    </>
  );
}
