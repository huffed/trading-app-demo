"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronRight, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  CAPITAL_PRESETS,
  EXPERIENCE_LABELS,
  GOAL_DESCRIPTIONS,
  GOAL_LABELS,
  INTEREST_LABELS,
  RISK_COMFORT_DESCRIPTIONS,
  RISK_COMFORT_LABELS,
  TIME_COMMITMENT_DESCRIPTIONS,
  TIME_COMMITMENT_LABELS,
} from "@/lib/constants/onboarding";
import { useOnboardingStore } from "@/stores/onboarding-store";
import type { TradingProfileAnswers } from "@/types/trading-profile";

const TOTAL_STEPS = 6;

interface WizardDialogProps {
  open: boolean;
  onComplete: (answers: TradingProfileAnswers) => Promise<string | null>;
}

// --- Step components ---

function OptionButton({
  selected,
  onClick,
  label,
  description,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  description?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-lg border p-3 text-left transition-colors cursor-pointer ${
        selected
          ? "border-primary bg-primary/5 ring-1 ring-primary"
          : "border-border hover:border-foreground/20"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        {selected && <Check className="h-4 w-4 text-primary" />}
      </div>
      {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
    </button>
  );
}

function StepGoal({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: TradingProfileAnswers["goal"]) => void;
}) {
  return (
    <div className="space-y-2">
      {Object.entries(GOAL_LABELS).map(([key, label]) => (
        <OptionButton
          key={key}
          selected={value === key}
          onClick={() => onChange(key as TradingProfileAnswers["goal"])}
          label={label}
          description={GOAL_DESCRIPTIONS[key]}
        />
      ))}
    </div>
  );
}

function StepRisk({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: TradingProfileAnswers["risk_comfort"]) => void;
}) {
  return (
    <div className="space-y-2">
      {Object.entries(RISK_COMFORT_LABELS).map(([key, label]) => (
        <OptionButton
          key={key}
          selected={value === key}
          onClick={() => onChange(key as TradingProfileAnswers["risk_comfort"])}
          label={label}
          description={RISK_COMFORT_DESCRIPTIONS[key]}
        />
      ))}
    </div>
  );
}

function StepCapital({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [custom, setCustom] = useState(false);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {CAPITAL_PRESETS.map((amount) => (
          <button
            key={amount}
            type="button"
            onClick={() => {
              setCustom(false);
              onChange(amount);
            }}
            className={`rounded-lg border p-2.5 text-sm font-medium transition-colors cursor-pointer ${
              value === amount && !custom
                ? "border-primary bg-primary/5 ring-1 ring-primary"
                : "border-border hover:border-foreground/20"
            }`}
          >
            ${amount.toLocaleString()}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setCustom(true)}
          className={`rounded-lg border p-2.5 text-sm font-medium transition-colors cursor-pointer ${
            custom
              ? "border-primary bg-primary/5 ring-1 ring-primary"
              : "border-border hover:border-foreground/20"
          }`}
        >
          Custom
        </button>
      </div>
      {custom && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">$</span>
          <Input
            type="number"
            min={50}
            max={1_000_000}
            value={value}
            onChange={(e) => onChange(Number(e.target.value) || 0)}
            autoFocus
          />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        This is simulated — no real money is used until you connect a broker.
      </p>
    </div>
  );
}

function StepInterests({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  function toggle(key: string) {
    if (key === "ai_picks") {
      onChange(value.includes("ai_picks") ? [] : ["ai_picks"]);
      return;
    }
    const without = value.filter((v) => v !== "ai_picks");
    onChange(without.includes(key) ? without.filter((v) => v !== key) : [...without, key]);
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      {Object.entries(INTEREST_LABELS).map(([key, label]) => (
        <button
          key={key}
          type="button"
          onClick={() => toggle(key)}
          className={`rounded-lg border p-2.5 text-left text-sm transition-colors cursor-pointer ${
            value.includes(key)
              ? "border-primary bg-primary/5 ring-1 ring-primary"
              : "border-border hover:border-foreground/20"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="font-medium">{label}</span>
            {value.includes(key) && <Check className="h-3.5 w-3.5 text-primary" />}
          </div>
        </button>
      ))}
    </div>
  );
}

function StepTime({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: TradingProfileAnswers["time_commitment"]) => void;
}) {
  return (
    <div className="space-y-2">
      {Object.entries(TIME_COMMITMENT_LABELS).map(([key, label]) => (
        <OptionButton
          key={key}
          selected={value === key}
          onClick={() => onChange(key as TradingProfileAnswers["time_commitment"])}
          label={label}
          description={TIME_COMMITMENT_DESCRIPTIONS[key]}
        />
      ))}
    </div>
  );
}

function StepExperience({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: TradingProfileAnswers["experience_level"]) => void;
}) {
  return (
    <div className="space-y-2">
      {Object.entries(EXPERIENCE_LABELS).map(([key, label]) => (
        <OptionButton
          key={key}
          selected={value === key}
          onClick={() => onChange(key as TradingProfileAnswers["experience_level"])}
          label={label}
        />
      ))}
    </div>
  );
}

// --- Step configuration ---

const STEP_CONFIG = [
  { title: "What's your main goal?", subtitle: "This helps us pick the right strategy for you." },
  {
    title: "How do you feel about risk?",
    subtitle: "There's no wrong answer — be honest with yourself.",
  },
  { title: "How much do you want to start with?", subtitle: "You can always change this later." },
  { title: "What interests you?", subtitle: "Pick as many as you like — or let the AI decide." },
  {
    title: "How much time do you want to spend?",
    subtitle: "This determines how active your strategy will be.",
  },
  {
    title: "How much trading experience do you have?",
    subtitle: "This helps the AI explain things at the right level.",
  },
];

// --- Main dialog ---

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

  function canAdvance(): boolean {
    if (step === 3) return answers.interests.length > 0;
    return true;
  }

  function handleSkip() {
    setWizardDismissed();
  }

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

  const config = STEP_CONFIG[step];

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleSkip()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg">{config.title}</DialogTitle>
          <p className="text-sm text-muted-foreground">{config.subtitle}</p>
        </DialogHeader>

        {/* Progress bar */}
        <div className="flex gap-1">
          {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
            <div
              key={i}
              className={`h-1 flex-1 rounded-full transition-colors ${
                i <= step ? "bg-primary" : "bg-muted"
              }`}
            />
          ))}
        </div>

        {/* Step content */}
        <div className="py-2">
          {step === 0 && (
            <StepGoal
              value={answers.goal}
              onChange={(v) => setAnswers((p) => ({ ...p, goal: v }))}
            />
          )}
          {step === 1 && (
            <StepRisk
              value={answers.risk_comfort}
              onChange={(v) => setAnswers((p) => ({ ...p, risk_comfort: v }))}
            />
          )}
          {step === 2 && (
            <StepCapital
              value={answers.capital}
              onChange={(v) => setAnswers((p) => ({ ...p, capital: v }))}
            />
          )}
          {step === 3 && (
            <StepInterests
              value={answers.interests}
              onChange={(v) => setAnswers((p) => ({ ...p, interests: v }))}
            />
          )}
          {step === 4 && (
            <StepTime
              value={answers.time_commitment}
              onChange={(v) => setAnswers((p) => ({ ...p, time_commitment: v }))}
            />
          )}
          {step === 5 && (
            <StepExperience
              value={answers.experience_level}
              onChange={(v) => setAnswers((p) => ({ ...p, experience_level: v }))}
            />
          )}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between pt-2">
          <Button variant="ghost" size="sm" onClick={handleSkip}>
            Skip
          </Button>
          <div className="flex gap-2">
            {step > 0 && (
              <Button variant="outline" size="sm" onClick={() => setStep((s) => s - 1)}>
                Back
              </Button>
            )}
            {step < TOTAL_STEPS - 1 ? (
              <Button size="sm" disabled={!canAdvance()} onClick={() => setStep((s) => s + 1)}>
                Next
                <ChevronRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button size="sm" onClick={handleFinish}>
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                Generate my first algorithm
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
