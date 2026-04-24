"use client";

import { useState } from "react";
import { completeOnboarding } from "@/app/(dashboard)/onboarding/actions";
import { useOnboardingStore } from "@/stores/onboarding-store";
import { TourOverlay } from "./tour-overlay";

interface TourProviderProps {
  onboardingCompleted: boolean;
}

export function TourProvider({ onboardingCompleted }: TourProviderProps) {
  const { tourCompleted, setTourCompleted, setWizardPending } = useOnboardingStore();
  const [dismissed, setDismissed] = useState(false);

  const shouldShow = !onboardingCompleted && !tourCompleted && !dismissed;

  if (!shouldShow) return null;

  async function handleComplete() {
    setDismissed(true);
    setTourCompleted();
    setWizardPending();
    await completeOnboarding();
  }

  return <TourOverlay onComplete={handleComplete} />;
}
