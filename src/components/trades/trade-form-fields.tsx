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
import { ASSET_CLASS_LABELS } from "@/lib/constants/algorithm";
import { assetClasses, tradeSides, tradeStatuses } from "@/lib/validators/trade";

export interface TradeFormState {
  symbol: string;
  asset_class: string;
  side: string;
  quantity: string;
  entry_price: string;
  exit_price: string;
  entry_date: string;
  exit_date: string;
  commission: string;
  fees: string;
  strategy: string;
  notes: string;
  status: string;
  currency: string;
  tags: string[];
}

export interface FieldProps {
  form: TradeFormState;
  errors: Record<string, string>;
  updateField: (field: string, value: string) => void;
}


export function toDatetimeLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

export function InstrumentFields({ form, errors, updateField }: FieldProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="space-y-1.5">
        <Label htmlFor="symbol">Symbol</Label>
        <Input
          id="symbol"
          placeholder="AAPL"
          value={form.symbol}
          onChange={(e) => updateField("symbol", e.target.value)}
        />
        {errors.symbol && <p className="text-xs text-destructive">{errors.symbol}</p>}
      </div>
      <div className="space-y-1.5">
        <Label>Asset Class</Label>
        <Select
          value={form.asset_class}
          onValueChange={(v) => updateField("asset_class", v as string)}
        >
          <SelectTrigger className="w-full">
            <SelectValue>{ASSET_CLASS_LABELS[form.asset_class] ?? form.asset_class}</SelectValue>
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
        <Label>Currency</Label>
        <Input value={form.currency} onChange={(e) => updateField("currency", e.target.value)} />
      </div>
    </div>
  );
}

function PriceField({
  id,
  label,
  placeholder,
  value,
  error,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  error?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        step="any"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

export function PositionFields({ form, errors, updateField }: FieldProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-4">
      <div className="space-y-1.5">
        <Label>Side</Label>
        <Select value={form.side} onValueChange={(v) => updateField("side", v as string)}>
          <SelectTrigger className="w-full">
            <SelectValue>{form.side === "long" ? "Long" : "Short"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {tradeSides.map((s) => (
              <SelectItem key={s} value={s}>
                {s === "long" ? "Long" : "Short"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <PriceField
        id="quantity"
        label="Quantity"
        placeholder="100"
        value={form.quantity}
        error={errors.quantity}
        onChange={(v) => updateField("quantity", v)}
      />
      <PriceField
        id="entry_price"
        label="Entry Price"
        placeholder="150.00"
        value={form.entry_price}
        error={errors.entry_price}
        onChange={(v) => updateField("entry_price", v)}
      />
      <PriceField
        id="exit_price"
        label="Exit Price"
        placeholder="155.00"
        value={form.exit_price}
        error={errors.exit_price}
        onChange={(v) => updateField("exit_price", v)}
      />
    </div>
  );
}

export function TimingFields({ form, errors, updateField }: FieldProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="space-y-1.5">
        <Label htmlFor="entry_date">Entry Date</Label>
        <Input
          id="entry_date"
          type="datetime-local"
          value={form.entry_date}
          onChange={(e) => updateField("entry_date", e.target.value)}
        />
        {errors.entry_date && <p className="text-xs text-destructive">{errors.entry_date}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="exit_date">Exit Date</Label>
        <Input
          id="exit_date"
          type="datetime-local"
          value={form.exit_date}
          onChange={(e) => updateField("exit_date", e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Status</Label>
        <Select value={form.status} onValueChange={(v) => updateField("status", v as string)}>
          <SelectTrigger className="w-full">
            <SelectValue>{form.status === "open" ? "Open" : "Closed"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {tradeStatuses.map((s) => (
              <SelectItem key={s} value={s}>
                {s === "open" ? "Open" : "Closed"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export function CostFields({ form, updateField }: Omit<FieldProps, "errors">) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="commission">Commission</Label>
        <Input
          id="commission"
          type="number"
          step="any"
          value={form.commission}
          onChange={(e) => updateField("commission", e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="fees">Fees</Label>
        <Input
          id="fees"
          type="number"
          step="any"
          value={form.fees}
          onChange={(e) => updateField("fees", e.target.value)}
        />
      </div>
    </div>
  );
}

export function MetadataFields({ form, updateField }: Omit<FieldProps, "errors">) {
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="strategy">Strategy</Label>
        <Input
          id="strategy"
          placeholder="e.g. Momentum breakout"
          value={form.strategy}
          onChange={(e) => updateField("strategy", e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="notes">Notes</Label>
        <Textarea
          id="notes"
          placeholder="Trade rationale, observations..."
          rows={3}
          value={form.notes}
          onChange={(e) => updateField("notes", e.target.value)}
        />
      </div>
    </>
  );
}
