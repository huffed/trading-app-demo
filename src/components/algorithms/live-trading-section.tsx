"use client";

import Link from "next/link";
import { Briefcase, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBrokerConnections } from "@/hooks/use-broker-connections";

interface LiveTradingState {
  liveEnabled: boolean;
  brokerId: string | null;
}

interface LiveTradingSectionProps {
  state: LiveTradingState;
  onChange: (next: LiveTradingState) => void;
}

const NO_BROKER_VALUE = "__none__";

function NoBrokersEmpty() {
  return (
    <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground space-y-2">
      <p>No broker connections yet. Add one before enabling live trading.</p>
      <Button
        variant="outline"
        size="xs"
        render={<Link href="/settings/brokers" />}
        nativeButton={false}
      >
        Manage brokers
      </Button>
    </div>
  );
}

function ActiveBanner({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-[var(--profit)]/30 bg-[var(--profit)]/5 p-2 text-xs flex gap-2">
      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--profit)]" />
      <p>
        Real orders will be placed on <strong>{label}</strong> alongside paper positions on every
        scan. Test thoroughly on the demo account before going to a funded one.
      </p>
    </div>
  );
}

interface ConfiguredProps {
  state: LiveTradingState;
  onChange: (next: LiveTradingState) => void;
  brokers: ReturnType<typeof useBrokerConnections>["data"];
  selectedBroker: NonNullable<ReturnType<typeof useBrokerConnections>["data"]>[number] | null;
  canEnable: boolean;
}

function ConfiguredFields({ state, onChange, brokers, selectedBroker, canEnable }: ConfiguredProps) {
  function handleBrokerChange(value: string | null) {
    if (!value || value === NO_BROKER_VALUE) {
      onChange({ liveEnabled: false, brokerId: null });
      return;
    }
    onChange({ ...state, brokerId: value });
  }
  function toggleLive() {
    if (!canEnable) return;
    onChange({ ...state, liveEnabled: !state.liveEnabled });
  }
  return (
    <>
      <div className="space-y-1.5">
        <Label className="text-xs">Broker</Label>
        <Select value={state.brokerId ?? NO_BROKER_VALUE} onValueChange={handleBrokerChange}>
          <SelectTrigger className="w-full">
            <SelectValue>
              {selectedBroker ? selectedBroker.label : "No broker — paper only"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_BROKER_VALUE}>No broker — paper only</SelectItem>
            {(brokers ?? []).map((b) => (
              <SelectItem key={b.id} value={b.id} disabled={b.status !== "active"}>
                {b.label}
                {b.status !== "active" ? ` (${b.status})` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-start gap-2">
        <Button
          type="button"
          variant={state.liveEnabled ? "default" : "outline"}
          size="sm"
          onClick={toggleLive}
          disabled={!canEnable}
        >
          {state.liveEnabled ? "Disable live trading" : "Enable live trading"}
        </Button>
        {!canEnable && state.brokerId && (
          <p className="text-xs text-muted-foreground">
            Selected broker isn&apos;t active — refresh the connection in Settings → Brokers first.
          </p>
        )}
      </div>
      {state.liveEnabled && selectedBroker && <ActiveBanner label={selectedBroker.label} />}
    </>
  );
}

export function LiveTradingSection({ state, onChange }: LiveTradingSectionProps) {
  const { data: brokers = [], isLoading } = useBrokerConnections();
  const hasAnyBroker = brokers.length > 0;
  const selectedBroker = brokers.find((b) => b.id === state.brokerId) ?? null;
  const canEnable = !!selectedBroker && selectedBroker.status === "active";

  return (
    <div className="space-y-3 border-t pt-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
          <Briefcase className="h-3 w-3" />
          Live Trading
        </h4>
        {state.liveEnabled && (
          <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--profit)] flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--profit)]" />
            Active
          </span>
        )}
      </div>
      {!hasAnyBroker && !isLoading && <NoBrokersEmpty />}
      {hasAnyBroker && (
        <ConfiguredFields
          state={state}
          onChange={onChange}
          brokers={brokers}
          selectedBroker={selectedBroker}
          canEnable={canEnable}
        />
      )}
    </div>
  );
}
