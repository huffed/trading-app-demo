"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { saveTradingProfileAndGenerate } from "@/app/(dashboard)/onboarding/actions";
import { WizardDialog } from "@/components/onboarding/wizard-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useTradingProfile } from "@/hooks/use-trading-profile";
import {
  EXPERIENCE_LABELS,
  GOAL_LABELS,
  INTEREST_LABELS,
  RISK_COMFORT_LABELS,
  TIME_COMMITMENT_LABELS,
} from "@/lib/constants/onboarding";
import type { TradingProfileAnswers } from "@/types/trading-profile";

function ProfileDisplay({ answers }: { answers: TradingProfileAnswers }) {
  const rows: { label: string; value: string }[] = [
    { label: "Goal", value: GOAL_LABELS[answers.goal] ?? answers.goal },
    {
      label: "Risk comfort",
      value: RISK_COMFORT_LABELS[answers.risk_comfort] ?? answers.risk_comfort,
    },
    { label: "Starting capital", value: `$${answers.capital.toLocaleString()}` },
    {
      label: "Interests",
      value: answers.interests.map((i) => INTEREST_LABELS[i] ?? i).join(", "),
    },
    {
      label: "Time commitment",
      value: TIME_COMMITMENT_LABELS[answers.time_commitment] ?? answers.time_commitment,
    },
    {
      label: "Experience",
      value: EXPERIENCE_LABELS[answers.experience_level] ?? answers.experience_level,
    },
  ];

  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div key={r.label} className="flex items-start justify-between gap-4">
          <span className="text-sm text-muted-foreground">{r.label}</span>
          <span className="text-sm font-medium text-right">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function ProfilePage() {
  const { data: profile, isLoading } = useTradingProfile();
  const [wizardOpen, setWizardOpen] = useState(false);

  async function handleWizardComplete(answers: TradingProfileAnswers): Promise<string | null> {
    const result = await saveTradingProfileAndGenerate(answers);
    if (result.success) {
      setWizardOpen(false);
      return result.data;
    }
    return null;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
        <p className="text-sm text-muted-foreground">
          Your trading preferences and personal information.
        </p>
      </div>

      <Card className="max-w-2xl">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium">Trading Preferences</CardTitle>
          {profile && (
            <Button variant="ghost" size="sm" onClick={() => setWizardOpen(true)}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              Edit
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="space-y-4">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-2/3" />
            </div>
          )}
          {!isLoading && profile && <ProfileDisplay answers={profile.answers} />}
          {!isLoading && !profile && (
            <div className="text-center py-6 space-y-3">
              <p className="text-sm text-muted-foreground">
                No trading preferences set yet. Complete the setup wizard to personalize your
                experience.
              </p>
              <Button size="sm" onClick={() => setWizardOpen(true)}>
                Set up preferences
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {wizardOpen && <WizardDialog open={wizardOpen} onComplete={handleWizardComplete} />}
    </div>
  );
}
