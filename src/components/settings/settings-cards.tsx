"use client";

import Link from "next/link";
import { ArrowRight, Briefcase, Key } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useTradingProfile } from "@/hooks/use-trading-profile";
import { EXPERIENCE_LABELS, GOAL_LABELS, RISK_COMFORT_LABELS } from "@/lib/constants/onboarding";

export function TradingPreferencesCard() {
  const { data: profile, isLoading } = useTradingProfile();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Trading Preferences</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!profile) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between p-4">
          <p className="text-sm text-muted-foreground">No trading preferences set yet.</p>
          <Button
            size="sm"
            variant="outline"
            render={<Link href="/settings/profile" />}
            nativeButton={false}
          >
            Set up
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium">Trading Preferences</CardTitle>
        <Button
          size="sm"
          variant="ghost"
          render={<Link href="/settings/profile" />}
          nativeButton={false}
        >
          Edit <ArrowRight className="ml-1 h-3.5 w-3.5" />
        </Button>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-3 text-sm">
          <div>
            <p className="text-muted-foreground text-xs">Goal</p>
            <p className="font-medium">
              {GOAL_LABELS[profile.answers.goal] ?? profile.answers.goal}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Risk Comfort</p>
            <p className="font-medium">
              {RISK_COMFORT_LABELS[profile.answers.risk_comfort] ?? profile.answers.risk_comfort}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Experience</p>
            <p className="font-medium">
              {EXPERIENCE_LABELS[profile.answers.experience_level] ??
                profile.answers.experience_level}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function ApiKeysCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Key className="h-4 w-4" /> Market-data API Keys
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Twelve Data, Finnhub, and Alpha Vantage keys live in <code>.env.local</code> for now —
          UI-managed market-data keys are on the roadmap.
        </p>
      </CardContent>
    </Card>
  );
}

export function BrokerConnectionsCard() {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Briefcase className="h-4 w-4" /> Broker Connections
        </CardTitle>
        <Button
          size="sm"
          variant="ghost"
          render={<Link href="/settings/brokers" />}
          nativeButton={false}
        >
          Manage <ArrowRight className="ml-1 h-3.5 w-3.5" />
        </Button>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Connect MT5/MT4 brokers (FTMO, ICMarkets, OANDA) via MetaApi to read live account state
          and — soon — let algorithms execute real trades.
        </p>
      </CardContent>
    </Card>
  );
}
