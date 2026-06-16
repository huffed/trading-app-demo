"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Small numeric input with label + optional suffix. Used by prop-firm-fields
 * and news-veto-section for per-field overrides. Previously lived in
 * generate-form-sections.tsx (deleted PR #270); broken out here so the edit
 * form components don't depend on the deleted generate-form file.
 */
export function NumericOverride({
  label,
  value,
  placeholder,
  suffix,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  suffix?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          step="any"
          min={0}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
      </div>
    </div>
  );
}
