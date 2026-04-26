"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, User } from "lucide-react";
import { getExchangeRate, getProfile, updateProfile } from "@/app/(dashboard)/settings/actions";
import { ApiKeysCard, TradingPreferencesCard } from "@/components/settings/settings-cards";
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
import { Skeleton } from "@/components/ui/skeleton";
import { setActiveCurrency } from "@/lib/utils/pnl";

const TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Hong_Kong",
  "Asia/Singapore",
  "Australia/Sydney",
];

const CURRENCIES = ["USD", "GBP", "EUR", "CAD", "AUD", "JPY"];

function SaveButton({
  saving,
  saved,
  onSave,
}: {
  saving: boolean;
  saved: boolean;
  onSave: () => void;
}) {
  if (saving) {
    return (
      <Button size="sm" disabled>
        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Saving...
      </Button>
    );
  }
  if (saved) {
    return (
      <Button size="sm" disabled>
        <Check className="mr-1.5 h-3.5 w-3.5" /> Saved
      </Button>
    );
  }
  return (
    <Button size="sm" onClick={onSave}>
      Save Changes
    </Button>
  );
}

function SettingsSelect({
  label,
  value,
  options,
  onValueChange,
  formatLabel,
}: {
  label: string;
  value: string;
  options: string[];
  onValueChange: (v: string) => void;
  formatLabel?: (v: string) => string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select
        value={value}
        onValueChange={(v) => {
          if (v) {
            onValueChange(v);
          }
        }}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {formatLabel ? formatLabel(o) : o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function GeneralForm({
  email,
  name,
  setName,
  timezone,
  setTimezone,
  currency,
  setCurrency,
  saving,
  saved,
  onSave,
}: {
  email: string;
  name: string;
  setName: (v: string) => void;
  timezone: string;
  setTimezone: (v: string) => void;
  currency: string;
  setCurrency: (v: string) => void;
  saving: boolean;
  saved: boolean;
  onSave: () => void;
}) {
  return (
    <CardContent className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" value={email} disabled />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="name">Display Name</Label>
        <Input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsSelect
          label="Timezone"
          value={timezone}
          options={TIMEZONES}
          onValueChange={setTimezone}
          formatLabel={(v) => v.replace(/_/g, " ")}
        />
        <SettingsSelect
          label="Currency"
          value={currency}
          options={CURRENCIES}
          onValueChange={setCurrency}
        />
      </div>
      <div className="flex justify-end">
        <SaveButton saving={saving} saved={saved} onSave={onSave} />
      </div>
    </CardContent>
  );
}

function GeneralSettings() {
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [currency, setCurrency] = useState("USD");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getProfile().then((r) => {
      if (r.success) {
        setName(r.data.full_name ?? "");
        setTimezone(r.data.timezone);
        setCurrency(r.data.default_currency);
        setEmail(r.data.email);
      }
      setLoading(false);
    });
  }, []);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    const result = await updateProfile({
      full_name: name || undefined,
      timezone,
      default_currency: currency,
    });
    setSaving(false);
    if (result.success) {
      const rateResult = await getExchangeRate(currency);
      setActiveCurrency(currency, rateResult.success ? rateResult.data : 1);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }

  const header = (
    <CardHeader>
      <CardTitle className="text-sm font-medium flex items-center gap-2">
        <User className="h-4 w-4" /> General
      </CardTitle>
    </CardHeader>
  );

  if (loading) {
    return (
      <Card>
        {header}
        <CardContent className="space-y-4">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      {header}
      <GeneralForm
        email={email}
        name={name}
        setName={setName}
        timezone={timezone}
        setTimezone={setTimezone}
        currency={currency}
        setCurrency={setCurrency}
        saving={saving}
        saved={saved}
        onSave={handleSave}
      />
    </Card>
  );
}

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Manage your account and preferences.</p>
      </div>
      <div className="max-w-2xl space-y-4">
        <GeneralSettings />
        <TradingPreferencesCard />
        <ApiKeysCard />
      </div>
    </div>
  );
}
