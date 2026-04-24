"use client";

import { useState } from "react";
import { HelpCircle, X } from "lucide-react";
import { getTip, personalizeTip } from "@/lib/content/tips";
import { useOnboardingStore } from "@/stores/onboarding-store";

interface ContextualTipProps {
  tipId: string;
  personalizedValue?: string;
}

function TipPopover({
  content,
  onDismiss,
  onClose,
}: {
  content: string;
  onDismiss: () => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute top-full left-0 z-50 mt-1 w-64 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md">
      <button
        type="button"
        onClick={onClose}
        className="absolute top-2 right-2 text-muted-foreground hover:text-foreground cursor-pointer"
      >
        <X className="h-3 w-3" />
      </button>
      <p className="text-xs leading-relaxed whitespace-pre-line pr-4">{content}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-2 text-xs text-primary hover:underline cursor-pointer"
      >
        Got it, don&apos;t show again
      </button>
    </div>
  );
}

export function ContextualTip({ tipId, personalizedValue }: ContextualTipProps) {
  const { isTipDismissed, dismissTip } = useOnboardingStore();
  const [open, setOpen] = useState(false);

  if (isTipDismissed(tipId)) return null;

  const tip = getTip(tipId);
  if (!tip) return null;

  const content = personalizedValue ? personalizeTip(tip, personalizedValue) : tip.body;

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </button>
      {open && (
        <TipPopover
          content={content}
          onDismiss={() => {
            dismissTip(tipId);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}
