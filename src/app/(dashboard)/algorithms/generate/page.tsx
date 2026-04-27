"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, MessageCircle, Sparkles } from "lucide-react";
import { GenerateForm } from "@/components/algorithms/generate-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useGenerateAlgorithm } from "@/hooks/use-algorithms";
import {
  algorithmFormSchema,
  type AlgorithmFormValues,
} from "@/lib/validators/algorithm";

export default function GenerateAlgorithmPage() {
  const router = useRouter();
  const generate = useGenerateAlgorithm();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(values: AlgorithmFormValues) {
    setError(null);
    const parsed = algorithmFormSchema.safeParse(values);
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    generate.mutate(parsed.data, {
      onSuccess: (r) => {
        if (r.success) {
          router.push(`/algorithms/${r.data.id}`);
        } else {
          setError(r.error);
        }
      },
      onError: () => setError("Generation failed. Please try again."),
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
        <h1 className="text-2xl font-semibold tracking-tight">Generate Algorithm</h1>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Set your preferences
          </CardTitle>
        </CardHeader>
        <CardContent>
          <GenerateForm onSubmit={handleSubmit} disabled={generate.isPending} />
          {error && <p className="mt-3 text-xs text-[var(--loss)]">{error}</p>}
          {generate.isPending && (
            <p className="mt-3 text-xs text-muted-foreground">
              The AI is designing your strategy and writing the rules — this usually takes 5-10
              seconds.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-start gap-3 py-4">
          <MessageCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="flex-1 space-y-1">
            <p className="text-sm font-medium">Prefer to chat?</p>
            <p className="text-xs text-muted-foreground">
              Open the AI chat in the bottom-right corner and describe what you want — e.g.
              &quot;Create me a swing trading strategy for tech stocks&quot;. The AI will ask
              follow-up questions and build it for you.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
