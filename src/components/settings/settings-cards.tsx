"use client";

import Link from "next/link";
import { ArrowRight, Briefcase, Key } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
