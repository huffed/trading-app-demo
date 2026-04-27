"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSaveBrokerConnection } from "@/hooks/use-broker-connections";
import type { MetaApiRegion } from "@/types/broker";

const REGIONS: { value: MetaApiRegion; label: string }[] = [
  { value: "london", label: "London (default)" },
  { value: "new-york", label: "New York" },
  { value: "singapore", label: "Singapore" },
];

interface FormState {
  label: string;
  brokerName: string;
  token: string;
  accountId: string;
  region: MetaApiRegion;
  server: string;
  accountLogin: string;
}

const EMPTY: FormState = {
  label: "",
  brokerName: "FTMO",
  token: "",
  accountId: "",
  region: "london",
  server: "",
  accountLogin: "",
};

function FormIntro() {
  return (
    <p className="text-xs text-muted-foreground">
      Brokers connect via{" "}
      <a
        href="https://metaapi.cloud"
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:text-foreground"
      >
        MetaApi.cloud
      </a>
      . Sign up there, deploy your MT5 account, then paste the auth token + account ID below.
      Your broker password lives only on MetaApi&apos;s side — this app never sees it.
    </p>
  );
}

function IdentityRow({
  state,
  set,
}: {
  state: FormState;
  set: (next: FormState) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="b-label">Label</Label>
        <Input
          id="b-label"
          value={state.label}
          onChange={(e) => set({ ...state, label: e.target.value })}
          placeholder="FTMO Demo $10k"
          required
          maxLength={80}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="b-broker">Broker Name</Label>
        <Input
          id="b-broker"
          value={state.brokerName}
          onChange={(e) => set({ ...state, brokerName: e.target.value })}
          placeholder="FTMO"
          maxLength={80}
        />
      </div>
    </div>
  );
}

function CredentialsBlock({
  state,
  set,
}: {
  state: FormState;
  set: (next: FormState) => void;
}) {
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="b-token">MetaApi Auth Token</Label>
        <Input
          id="b-token"
          type="password"
          value={state.token}
          onChange={(e) => set({ ...state, token: e.target.value })}
          placeholder="eyJ…"
          required
          autoComplete="off"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="b-acct">MetaApi Account ID</Label>
          <Input
            id="b-acct"
            value={state.accountId}
            onChange={(e) => set({ ...state, accountId: e.target.value })}
            placeholder="UUID from MetaApi dashboard"
            required
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Region</Label>
          <Select
            value={state.region}
            onValueChange={(v) => v && set({ ...state, region: v as MetaApiRegion })}
          >
            <SelectTrigger className="w-full">
              <SelectValue>
                {REGIONS.find((r) => r.value === state.region)?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {REGIONS.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </>
  );
}

function DisplayMetaRow({
  state,
  set,
}: {
  state: FormState;
  set: (next: FormState) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="b-server">MT5 Server (display)</Label>
        <Input
          id="b-server"
          value={state.server}
          onChange={(e) => set({ ...state, server: e.target.value })}
          placeholder="FTMO-Demo"
          maxLength={80}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="b-login">MT5 Login (display)</Label>
        <Input
          id="b-login"
          value={state.accountLogin}
          onChange={(e) => set({ ...state, accountLogin: e.target.value })}
          placeholder="1234567"
          maxLength={40}
        />
      </div>
    </div>
  );
}

export function BrokerAddForm() {
  const [state, setState] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const save = useSaveBrokerConnection();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    save.mutate(
      {
        label: state.label.trim(),
        provider: "metaapi",
        api_token: state.token.trim(),
        account_id: state.accountId.trim(),
        region: state.region,
        broker_name: state.brokerName.trim() || undefined,
        server: state.server.trim() || undefined,
        account_login: state.accountLogin.trim() || undefined,
      },
      {
        onSuccess: (r) => {
          if (r.success) setState(EMPTY);
          else setError(r.error);
        },
        onError: () => setError("Save failed."),
      }
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Plus className="h-4 w-4" />
          Add Broker Connection
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-3">
          <FormIntro />
          <IdentityRow state={state} set={setState} />
          <CredentialsBlock state={state} set={setState} />
          <DisplayMetaRow state={state} set={setState} />
          {error && <p className="text-xs text-[var(--loss)]">{error}</p>}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save Connection"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
