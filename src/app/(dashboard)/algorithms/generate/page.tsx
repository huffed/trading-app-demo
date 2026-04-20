"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { GenerateForm } from "@/components/algorithms/generate-form";
import { GenerateResult } from "@/components/algorithms/generate-result";
import { Button } from "@/components/ui/button";
import { useGenerateAlgorithm } from "@/hooks/use-algorithms";
import { algorithmFormSchema } from "@/lib/validators/algorithm";

export default function GenerateAlgorithmPage() {
  const router = useRouter();
  const [streamText, setStreamText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const generateMutation = useGenerateAlgorithm();

  async function handleGenerate(values: Record<string, string>) {
    setStreamText("");
    setIsStreaming(true);

    try {
      const res = await fetch("/api/algorithms/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      if (!res.ok || !res.body) throw new Error("Generation failed");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullText += decoder.decode(value, { stream: true });
        setStreamText(fullText);
      }

      setIsStreaming(false);

      // Save via server action (non-streaming, parses + stores)
      const parsed = algorithmFormSchema.safeParse(values);
      if (parsed.success) {
        const result = await generateMutation.mutateAsync(parsed.data);
        if (result.success) {
          router.push("/algorithms");
        }
      }
    } catch {
      setIsStreaming(false);
    }
  }

  const isBusy = isStreaming || generateMutation.isPending;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" render={<Link href="/algorithms" />} nativeButton={false}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Generate Algorithm</h1>
          <p className="text-sm text-muted-foreground">
            Set your preferences and let AI design a strategy for you.
          </p>
        </div>
      </div>
      <GenerateForm onSubmit={handleGenerate} disabled={isBusy} />
      <GenerateResult text={streamText} isStreaming={isStreaming} />
    </div>
  );
}
