"use client";

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
import { riskLevels } from "@/lib/validators/algorithm";
import { assetClasses } from "@/lib/validators/trade";

interface GenerateFormProps {
  onSubmit: (values: Record<string, string>) => void;
  disabled: boolean;
}

const assetLabels: Record<string, string> = {
  equity: "Stocks", option: "Options", future: "Futures", forex: "Forex", crypto: "Crypto",
};
const riskLabels: Record<string, string> = {
  conservative: "Conservative", moderate: "Moderate", aggressive: "Aggressive",
};

export function GenerateForm({ onSubmit, disabled }: GenerateFormProps) {
  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    onSubmit(Object.fromEntries(fd) as Record<string, string>);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Asset Class</Label>
          <Select name="asset_class" defaultValue="equity">
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {assetClasses.map((ac) => (
                <SelectItem key={ac} value={ac}>{assetLabels[ac]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Risk Level</Label>
          <Select name="risk_level" defaultValue="moderate">
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {riskLevels.map((r) => (
                <SelectItem key={r} value={r}>{riskLabels[r]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="capital">Capital ($)</Label>
          <Input id="capital" name="capital" type="number" defaultValue="10000" step="any" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="time_horizon">Time Horizon</Label>
          <Input id="time_horizon" name="time_horizon" defaultValue="1d" placeholder="e.g. 1d, 4h, swing" />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="user_hints">Hints for the AI (optional)</Label>
        <Textarea
          id="user_hints"
          name="user_hints"
          placeholder="e.g. I prefer momentum strategies, avoid holding overnight, interested in tech stocks..."
          rows={3}
        />
      </div>
      <Button type="submit" disabled={disabled} className="w-full">
        {disabled ? "Generating..." : "Generate Algorithm"}
      </Button>
    </form>
  );
}
