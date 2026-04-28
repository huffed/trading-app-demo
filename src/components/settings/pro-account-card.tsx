"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, ShieldCheck } from "lucide-react";
import {
  type AutonomyLevel,
  type PropFirmPresetSetting,
  getProfile,
  updateProfile,
} from "@/app/(dashboard)/settings/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AUTONOMY_LEVEL_DESCRIPTIONS,
  AUTONOMY_LEVEL_LABELS,
} from "@/lib/constants/algorithm";
import { PROP_FIRM_LABELS } from "@/lib/constants/prop-firm";

const PROP_FIRM_OPTIONS: PropFirmPresetSetting[] = [
  null,
  "ftmo",
  "funded_next",
  "topstep",
  "the5ers",
  "custom",
];

const AUTONOMY_OPTIONS: AutonomyLevel[] = [
  "paper_only",
  "suggest",
  "semi_auto",
  "full_auto",
];

const PROP_FIRM_NONE_VALUE = "__none__";

function propFirmToSelectValue(p: PropFirmPresetSetting): string {
  return p === null ? PROP_FIRM_NONE_VALUE : p;
}

function selectValueToPropFirm(v: string): PropFirmPresetSetting {
  if (v === PROP_FIRM_NONE_VALUE) return null;
  if (v === "ftmo" || v === "topstep" || v === "funded_next" || v === "the5ers" || v === "custom") {
    return v;
  }
  return null;
}

function PropFirmSelect({
  value,
  onValueChange,
}: {
  value: PropFirmPresetSetting;
  onValueChange: (v: PropFirmPresetSetting) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label>Prop-firm preset</Label>
      <Select
        value={propFirmToSelectValue(value)}
        onValueChange={(v) => v && onValueChange(selectValueToPropFirm(v))}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PROP_FIRM_OPTIONS.map((opt) => {
            const sv = propFirmToSelectValue(opt);
            const label = opt === null ? "None (retail / unconstrained)" : PROP_FIRM_LABELS[opt];
            return (
              <SelectItem key={sv} value={sv}>
                {label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        Default rules.prop_firm shape used when generating new algorithms. Existing algos
        keep their own settings.
      </p>
    </div>
  );
}

function AutonomySelect({
  value,
  onValueChange,
}: {
  value: AutonomyLevel;
  onValueChange: (v: AutonomyLevel) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label>Autonomy level</Label>
      <Select
        value={value}
        onValueChange={(v) => v && onValueChange(v as AutonomyLevel)}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {AUTONOMY_OPTIONS.map((opt) => (
            <SelectItem key={opt} value={opt}>
              {AUTONOMY_LEVEL_LABELS[opt]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{AUTONOMY_LEVEL_DESCRIPTIONS[value]}</p>
    </div>
  );
}

function SaveStateButton({
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
      Save
    </Button>
  );
}

export function ProAccountCard() {
  const [propFirm, setPropFirm] = useState<PropFirmPresetSetting>(null);
  const [autonomy, setAutonomy] = useState<AutonomyLevel>("paper_only");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getProfile().then((r) => {
      if (r.success) {
        setPropFirm(r.data.prop_firm_preset);
        setAutonomy(r.data.autonomy_level);
      }
      setLoading(false);
    });
  }, []);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    const result = await updateProfile({
      prop_firm_preset: propFirm,
      autonomy_level: autonomy,
    });
    setSaving(false);
    if (result.success) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }

  const header = (
    <CardHeader>
      <CardTitle className="text-sm font-medium flex items-center gap-2">
        <ShieldCheck className="h-4 w-4" /> Pro-account preferences
      </CardTitle>
    </CardHeader>
  );

  if (loading) {
    return (
      <Card>
        {header}
        <CardContent className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      {header}
      <CardContent className="space-y-4">
        <PropFirmSelect value={propFirm} onValueChange={setPropFirm} />
        <AutonomySelect value={autonomy} onValueChange={setAutonomy} />
        <div className="flex justify-end">
          <SaveStateButton saving={saving} saved={saved} onSave={handleSave} />
        </div>
      </CardContent>
    </Card>
  );
}
