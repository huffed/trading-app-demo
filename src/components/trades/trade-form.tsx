"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useCreateTrade, useUpdateTrade } from "@/hooks/use-trades";
import { tradeFormSchema, type TradeFormValues } from "@/lib/validators/trade";
import type { Trade } from "@/types/trade";
import {
  CostFields,
  InstrumentFields,
  MetadataFields,
  PositionFields,
  TimingFields,
  toDatetimeLocal,
  type TradeFormState,
} from "./trade-form-fields";

interface TradeFormProps {
  trade?: Trade;
  onSuccess?: () => void;
}

function buildInitialState(trade?: Trade): TradeFormState {
  return {
    symbol: trade?.symbol ?? "",
    asset_class: trade?.asset_class ?? "equity",
    side: trade?.side ?? "long",
    quantity: trade?.quantity?.toString() ?? "",
    entry_price: trade?.entry_price?.toString() ?? "",
    exit_price: trade?.exit_price?.toString() ?? "",
    entry_date: trade ? toDatetimeLocal(trade.entry_date) : "",
    exit_date: trade ? toDatetimeLocal(trade.exit_date) : "",
    commission: trade?.commission?.toString() ?? "0",
    fees: trade?.fees?.toString() ?? "0",
    strategy: trade?.strategy ?? "",
    notes: trade?.notes ?? "",
    status: trade?.status ?? "open",
    currency: trade?.currency ?? "USD",
    tags: trade?.tags ?? [],
  };
}

function parseForm(form: TradeFormState) {
  const parsed = tradeFormSchema.safeParse(form);
  if (parsed.success) {
    return { success: true as const, data: parsed.data as TradeFormValues };
  }

  const fieldErrors: Record<string, string> = {};
  const unmappedErrors: string[] = [];
  for (const issue of parsed.error.issues) {
    const key = issue.path[0]?.toString();
    if (key) {
      if (!fieldErrors[key]) {
        fieldErrors[key] = issue.message;
      }
    } else {
      unmappedErrors.push(issue.message);
    }
  }
  return { success: false as const, fieldErrors, unmappedErrors };
}

export function TradeForm({ trade, onSuccess }: TradeFormProps) {
  const isEdit = !!trade;
  const createTrade = useCreateTrade();
  const updateTrade = useUpdateTrade();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [form, setForm] = useState(() => buildInitialState(trade));

  function updateField(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);

    const result = parseForm(form);
    if (!result.success) {
      setErrors(result.fieldErrors);
      if (result.unmappedErrors.length > 0) {
        setServerError(result.unmappedErrors.join(". "));
      }
      return;
    }

    const action = isEdit
      ? await updateTrade.mutateAsync({ id: trade!.id, values: result.data })
      : await createTrade.mutateAsync(result.data);

    if (!action.success) {
      setServerError(action.error);
      return;
    }
    onSuccess?.();
  }

  const isPending = createTrade.isPending || updateTrade.isPending;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {serverError && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {serverError}
        </div>
      )}
      <InstrumentFields form={form} errors={errors} updateField={updateField} />
      <PositionFields form={form} errors={errors} updateField={updateField} />
      <TimingFields form={form} errors={errors} updateField={updateField} />
      <CostFields form={form} updateField={updateField} />
      <MetadataFields form={form} updateField={updateField} />
      <Button type="submit" disabled={isPending} className="w-full">
        {isPending && "Saving..."}
        {!isPending && isEdit && "Update Trade"}
        {!isPending && !isEdit && "Add Trade"}
      </Button>
    </form>
  );
}
