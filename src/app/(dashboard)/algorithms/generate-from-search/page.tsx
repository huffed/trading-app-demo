"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Telescope } from "lucide-react";
import type { GenerateFromSearchInput } from "@/app/(dashboard)/algorithms/generate-from-search-actions";
import { GenerateFromSearchForm } from "@/components/algorithms/generate-from-search-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useGenerateAlgorithmFromSearch } from "@/hooks/use-algorithms";

export default function GenerateFromSearchPage() {
  const router = useRouter();
  const generate = useGenerateAlgorithmFromSearch();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(input: GenerateFromSearchInput) {
    setError(null);
    generate.mutate(input, {
      onSuccess: (r) => {
        if (r.success) router.push(`/algorithms/${r.data.algorithm.id}`);
        else setError(r.error);
      },
      onError: () => setError("Search failed unexpectedly. Try again or loosen the constraints."),
    });
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon-sm"
          render={<Link href="/algorithms" />}
          nativeButton={false}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Search-find an algorithm</h1>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Telescope className="h-4 w-4 text-primary" />
            Define your target
          </CardTitle>
        </CardHeader>
        <CardContent>
          <GenerateFromSearchForm onSubmit={handleSubmit} disabled={generate.isPending} />
          {error && <p className="mt-3 text-xs text-[var(--loss)]">{error}</p>}
          {generate.isPending && (
            <p className="mt-3 text-xs text-muted-foreground">
              Searching the strategy grid against real walk-forward data — usually 1-3 minutes.
              Don&apos;t close the page.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 py-4 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">How this differs from chat-based generate:</p>
          <p>
            The chat path lets the LLM design rules from your natural-language brief. This path
            walks every template in the curated grid through walk-forward backtests on real price
            data, scores them by stability + return-per-DD, calibrates risk to your monthly target,
            and saves the best one as a draft.
          </p>
          <p>
            Watchlist symbols come from the search universe (forex / commodity catalogue). Risk is
            capped at FTMO-safe (max 2% per trade) regardless of target.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
