"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useOnboardingStore } from "@/stores/onboarding-store";
import type { TradingProfileAnswers } from "@/types/trading-profile";
import {
  STEP_CONFIG,
  StepCapital,
  StepExperience,
  StepGoal,
  StepInterests,
  StepRisk,
  StepTime,
} from "./wizard-steps";

const TOTAL_STEPS = 6;

interface WizardDialogProps {
  open: boolean;
  onComplete: (answers: TradingProfileAnswers) => Promise<string | null>;
}

function GeneratingView({ open }: { open: boolean }) {
  return (
    <Dialog open={open}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <div className="flex flex-col items-center justify-center py-8 space-y-4">
          <div className="relative">
            <Sparkles className="h-8 w-8 text-primary animate-pulse" />
          </div>
          <div className="text-center space-y-1">
            <p className="font-medium">Building your first strategy...</p>
            <p className="text-sm text-muted-foreground">
              The AI is creating an algorithm tailored to your preferences.
            </p>
          </div>
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StepContent({
  step,
  answers,
  setAnswers,
}: {
  step: number;
  answers: TradingProfileAnswers;
  setAnswers: React.Dispatch<React.SetStateAction<TradingProfileAnswers>>;
}) {
  if (step === 0) {
    return (
      <StepGoal value={answers.goal} onChange={(v) => setAnswers((p) => ({ ...p, goal: v }))} />
    );
  }
  if (step === 1) {
    return (
      <StepRisk
        value={answers.risk_comfort}
        onChange={(v) => setAnswers((p) => ({ ...p, risk_comfort: v }))}
      />
    );
  }
  if (step === 2) {
    return (
      <StepCapital
        value={answers.capital}
        onChange={(v) => setAnswers((p) => ({ ...p, capital: v }))}
      />
    );
  }
  if (step === 3) {
    return (
      <StepInterests
        value={answers.interests}
        onChange={(v) => setAnswers((p) => ({ ...p, interests: v }))}
      />
    );
  }
  if (step === 4) {
    return (
      <StepTime
        value={answers.time_commitment}
        onChange={(v) => setAnswers((p) => ({ ...p, time_commitment: v }))}
      />
    );
  }
  return (
    <StepExperience
      value={answers.experience_level}
      onChange={(v) => setAnswers((p) => ({ ...p, experience_level: v }))}
    />
  );
}

function ProgressBar({ step }: { step: number }) {
  return (
    <div className="flex gap-1">
      {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
        <div
          key={i}
          className={`h-1 flex-1 rounded-full transition-colors ${i <= step ? "bg-primary" : "bg-muted"}`}
        />
      ))}
    </div>
  );
}

function WizardNav({
  step,
  canAdvance,
  onBack,
  onNext,
  onSkip,
  onFinish,
}: {
  step: number;
  canAdvance: boolean;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
  onFinish: () => void;
}) {
  return (
    <div className="flex items-center justify-between pt-2">
      <Button variant="ghost" size="sm" onClick={onSkip}>
        Skip
      </Button>
      <div className="flex gap-2">
        {step > 0 && (
          <Button variant="outline" size="sm" onClick={onBack}>
            Back
          </Button>
        )}
        {step < TOTAL_STEPS - 1 ? (
          <Button size="sm" disabled={!canAdvance} onClick={onNext}>
            Next <ChevronRight className="ml-1 h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button size="sm" onClick={onFinish}>
            <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Generate my first algorithm
          </Button>
        )}
      </div>
    </div>
  );
}

export function WizardDialog({ open, onComplete }: WizardDialogProps) {
  const router = useRouter();
  const { setWizardDismissed } = useOnboardingStore();
  const [step, setStep] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [answers, setAnswers] = useState<TradingProfileAnswers>({
    goal: "grow_savings",
    risk_comfort: "some_ups_downs",
    capital: 1000,
    interests: [],
    time_commitment: "check_weekly",
    experience_level: "total_beginner",
  });

  async function handleFinish() {
    setIsGenerating(true);
    try {
      const algoId = await onComplete(answers);
      if (algoId) {
        router.push(`/algorithms/${algoId}`);
      }
    } finally {
      setIsGenerating(false);
    }
  }

  if (isGenerating) {
    return <GeneratingView open={open} />;
  }
  const config = STEP_CONFIG[step];

  return (
    <Dialog open={open} onOpenChange={(v) => !v && setWizardDismissed()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg">{config.title}</DialogTitle>
          <p className="text-sm text-muted-foreground">{config.subtitle}</p>
        </DialogHeader>
        <ProgressBar step={step} />
        <div className="py-2">
          <StepContent step={step} answers={answers} setAnswers={setAnswers} />
        </div>
        <WizardNav
          step={step}
          canAdvance={step === 3 ? answers.interests.length > 0 : true}
          onBack={() => setStep((s) => s - 1)}
          onNext={() => setStep((s) => s + 1)}
          onSkip={() => setWizardDismissed()}
          onFinish={handleFinish}
        />
      </DialogContent>
    </Dialog>
  );
}
