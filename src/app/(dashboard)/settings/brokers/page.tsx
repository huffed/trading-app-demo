"use client";

import Link from "next/link";
import { ArrowLeft, Briefcase } from "lucide-react";
import { BrokerAddForm } from "@/components/settings/broker-add-form";
import { BrokerCard } from "@/components/settings/broker-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useBrokerConnections } from "@/hooks/use-broker-connections";

export default function BrokersPage() {
  const { data: connections = [], isLoading, error } = useBrokerConnections();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon-sm"
          render={<Link href="/settings" />}
          nativeButton={false}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Briefcase className="h-5 w-5" />
            Broker Connections
          </h1>
          <p className="text-sm text-muted-foreground">
            Connect MT5 / MT4 broker accounts (FTMO, ICMarkets, OANDA, etc.) via MetaApi for live
            balance / equity / positions and to mirror paper-validated algorithms onto a live
            account.
          </p>
        </div>
      </div>
      <div className="max-w-2xl space-y-4">
        <BrokerAddForm />
        {isLoading && (
          <div className="space-y-3">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}
        {error && (
          <p className="text-sm text-[var(--loss)]">
            {error instanceof Error ? error.message : "Failed to load brokers."}
          </p>
        )}
        {!isLoading && connections.length === 0 && !error && (
          <p className="text-sm text-muted-foreground">
            No broker connections yet. Add one above.
          </p>
        )}
        {connections.map((conn) => (
          <BrokerCard key={conn.id} conn={conn} />
        ))}
      </div>
    </div>
  );
}
