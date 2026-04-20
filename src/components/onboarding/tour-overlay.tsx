"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { tourSteps } from "@/lib/content/tour-steps";

interface TourOverlayProps {
  onComplete: () => void;
}

function ProgressDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex gap-1.5">
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={`h-1.5 rounded-full transition-all ${
            i === current ? "w-4 bg-primary" : "w-1.5 bg-muted-foreground/30"
          }`}
        />
      ))}
    </div>
  );
}

export function TourOverlay({ onComplete }: TourOverlayProps) {
  const [step, setStep] = useState(0);
  const current = tourSteps[step];
  const isFirst = step === 0;
  const isLast = step === tourSteps.length - 1;

  return (
    <Dialog open onOpenChange={() => onComplete()}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <div className="text-3xl mb-2">{current.icon}</div>
          <DialogTitle>{current.title}</DialogTitle>
          <DialogDescription className="leading-relaxed">
            {current.description}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-row items-center justify-between">
          <ProgressDots current={step} total={tourSteps.length} />
          <div className="flex gap-2">
            {!isFirst && (
              <Button variant="ghost" size="sm" onClick={() => setStep(step - 1)}>
                <ChevronLeft className="mr-1 h-3 w-3" />
                Back
              </Button>
            )}
            {isFirst && (
              <Button variant="ghost" size="sm" onClick={onComplete}>
                Skip
              </Button>
            )}
            {isLast ? (
              <Button size="sm" onClick={onComplete}>
                Get Started
              </Button>
            ) : (
              <Button size="sm" onClick={() => setStep(step + 1)}>
                Next
                <ChevronRight className="ml-1 h-3 w-3" />
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
