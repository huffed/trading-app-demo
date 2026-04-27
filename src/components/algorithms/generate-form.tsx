"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ASSET_CLASS_LABELS, RISK_LEVEL_LABELS } from "@/lib/constants/algorithm";
import { type PropFirmPreset } from "@/lib/constants/prop-firm";
import { riskLevels, type AlgorithmFormValues } from "@/lib/validators/algorithm";
import { assetClasses } from "@/lib/validators/trade";
import type { NewsVetoRules, PropFirmRules } from "@/types/algorithm";
import {
  AdvancedSection,
  applyPropFirmPreset,
  buildOverrides,
  EMPTY_OVERRIDES,
  PropFirmSection,
  type OverrideState,
} from "./generate-form-sections";
import { NewsVetoSection } from "./news-veto-section";

interface GenerateFormProps {
  onSubmit: (values: AlgorithmFormValues) => void;
  disabled: boolean;
}

interface BasicFieldState {
  name: string;
  setName: (v: string) => void;
  assetClass: string;
  setAssetClass: (v: string) => void;
  riskLevel: string;
  setRiskLevel: (v: string) => void;
  capital: string;
  setCapital: (v: string) => void;
  timeHorizon: string;
  setTimeHorizon: (v: string) => void;
  hints: string;
  setHints: (v: string) => void;
}

function BasicFields(s: BasicFieldState) {
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="algo_name">Name (optional)</Label>
        <Input
          id="algo_name"
          value={s.name}
          onChange={(e) => s.setName(e.target.value)}
          placeholder="Leave blank to let the AI name it"
          maxLength={80}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Asset Class</Label>
          <Select value={s.assetClass} onValueChange={(v) => s.setAssetClass(v ?? "equity")}>
            <SelectTrigger className="w-full">
              <SelectValue>{ASSET_CLASS_LABELS[s.assetClass]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {assetClasses.map((ac) => (
                <SelectItem key={ac} value={ac}>
                  {ASSET_CLASS_LABELS[ac]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Risk Level</Label>
          <Select value={s.riskLevel} onValueChange={(v) => s.setRiskLevel(v ?? "moderate")}>
            <SelectTrigger className="w-full">
              <SelectValue>{RISK_LEVEL_LABELS[s.riskLevel]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {riskLevels.map((r) => (
                <SelectItem key={r} value={r}>
                  {RISK_LEVEL_LABELS[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="capital">Capital ($)</Label>
          <Input
            id="capital"
            type="number"
            value={s.capital}
            onChange={(e) => s.setCapital(e.target.value)}
            step="any"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="time_horizon">Time Horizon</Label>
          <Input
            id="time_horizon"
            value={s.timeHorizon}
            onChange={(e) => s.setTimeHorizon(e.target.value)}
            placeholder="e.g. 1h, 4h, 1d, swing"
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="user_hints">Hints for the AI (optional)</Label>
        <Textarea
          id="user_hints"
          value={s.hints}
          onChange={(e) => s.setHints(e.target.value)}
          placeholder="e.g. I prefer momentum strategies, avoid holding overnight, interested in tech stocks..."
          rows={3}
        />
      </div>
    </>
  );
}

interface FormState {
  name: string;
  assetClass: string;
  riskLevel: string;
  capital: string;
  timeHorizon: string;
  hints: string;
  overrides: OverrideState;
  propFirmPreset: PropFirmPreset | null;
  propFirmValues: PropFirmRules | null;
  newsVeto: NewsVetoRules | null;
}

function useFormState() {
  const [name, setName] = useState("");
  const [assetClass, setAssetClass] = useState("equity");
  const [riskLevel, setRiskLevel] = useState("moderate");
  const [capital, setCapital] = useState("10000");
  const [timeHorizon, setTimeHorizon] = useState("1d");
  const [hints, setHints] = useState("");
  const [overrides, setOverrides] = useState<OverrideState>(EMPTY_OVERRIDES);
  const [propFirmPreset, setPropFirmPreset] = useState<PropFirmPreset | null>(null);
  const [propFirmValues, setPropFirmValues] = useState<PropFirmRules | null>(null);
  const [newsVeto, setNewsVeto] = useState<NewsVetoRules | null>(null);

  return {
    name,
    setName,
    assetClass,
    setAssetClass,
    riskLevel,
    setRiskLevel,
    capital,
    setCapital,
    timeHorizon,
    setTimeHorizon,
    hints,
    setHints,
    overrides,
    setOverrides,
    propFirmPreset,
    setPropFirmPreset,
    propFirmValues,
    setPropFirmValues,
    newsVeto,
    setNewsVeto,
  };
}

function buildSubmitValues(s: FormState): AlgorithmFormValues {
  return {
    name: s.name.trim() || undefined,
    asset_class: s.assetClass as AlgorithmFormValues["asset_class"],
    risk_level: s.riskLevel as AlgorithmFormValues["risk_level"],
    capital: Number(s.capital),
    time_horizon: s.timeHorizon,
    user_hints: s.hints || undefined,
    overrides: buildOverrides(s.overrides),
    prop_firm: s.propFirmValues ?? undefined,
    news_veto: s.newsVeto ?? undefined,
  };
}

export function GenerateForm({ onSubmit, disabled }: GenerateFormProps) {
  const s = useFormState();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [propFirmOpen, setPropFirmOpen] = useState(false);
  const [newsVetoOpen, setNewsVetoOpen] = useState(false);

  function handlePropFirmPreset(p: PropFirmPreset | null) {
    const result = applyPropFirmPreset(p, s.propFirmValues);
    s.setPropFirmPreset(result.preset);
    s.setPropFirmValues(result.values);
  }

  function handlePropFirmEdit(v: PropFirmRules) {
    s.setPropFirmValues(v);
    s.setPropFirmPreset("custom");
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit(buildSubmitValues(s));
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <BasicFields {...s} />
      <AdvancedSection
        open={advancedOpen}
        onToggle={() => setAdvancedOpen((v) => !v)}
        overrides={s.overrides}
        setOverrides={s.setOverrides}
      />
      <NewsVetoSection
        open={newsVetoOpen}
        onToggle={() => setNewsVetoOpen((v) => !v)}
        values={s.newsVeto}
        onChange={s.setNewsVeto}
      />
      <PropFirmSection
        open={propFirmOpen}
        onToggle={() => setPropFirmOpen((v) => !v)}
        preset={s.propFirmPreset}
        values={s.propFirmValues}
        onPreset={handlePropFirmPreset}
        onChangeValues={handlePropFirmEdit}
      />
      <Button type="submit" disabled={disabled} className="w-full">
        {disabled ? "Generating..." : "Generate Algorithm"}
      </Button>
    </form>
  );
}
