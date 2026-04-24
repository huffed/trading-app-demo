"use client";

import { saveTradingProfileAndGenerate } from "@/app/(dashboard)/onboarding/actions";
import { useOnboardingStore } from "@/stores/onboarding-store";
import type { TradingProfileAnswers } from "@/types/trading-profile";
import { WizardDialog } from "./wizard-dialog";

interface WizardProviderProps {
  /** Whether the user already has a trading profile saved in the DB. */
  hasTradingProfile: boolean;
}

export function WizardProvider({ hasTradingProfile }: WizardProviderProps) {
  const { wizardPending, wizardDismissed, setWizardDismissed } = useOnboardingStore();

  // Show wizard if tour just completed (wizardPending) OR if onboarding is done
  // but no trading profile exists yet — and user hasn't dismissed it
  const shouldShow = !hasTradingProfile && !wizardDismissed && wizardPending;

  if (!shouldShow) return null;

  async function handleComplete(answers: TradingProfileAnswers): Promise<string | null> {
    const result = await saveTradingProfileAndGenerate(answers);
    if (result.success) {
      setWizardDismissed();
      return result.data;
    }
    return null;
  }

  return <WizardDialog open onComplete={handleComplete} />;
}
