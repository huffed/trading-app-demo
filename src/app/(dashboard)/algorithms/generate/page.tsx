"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Save, Send } from "lucide-react";
import { GenerateForm } from "@/components/algorithms/generate-form";
import { MessageBubble } from "@/components/chat/message-bubble";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useGenerateAlgorithm } from "@/hooks/use-algorithms";
import { algorithmFormSchema } from "@/lib/validators/algorithm";
import type { ChatMessage } from "@/types/chat";

function PageHeader() {
  return (
    <div className="flex items-center gap-3">
      <Button variant="ghost" size="icon-sm" render={<Link href="/algorithms" />} nativeButton={false}>
        <ArrowLeft className="h-4 w-4" />
      </Button>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Generate Algorithm</h1>
        <p className="text-sm text-muted-foreground">
          Set your preferences, then refine with the AI until you&apos;re happy.
        </p>
      </div>
    </div>
  );
}

function RefineInput({
  value,
  onChange,
  onSend,
  onSave,
  disabled,
  isSaving,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onSave: () => void;
  disabled: boolean;
  isSaving: boolean;
}) {
  return (
    <div className="flex gap-2">
      <form className="flex flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); onSend(); }}>
        <Input
          placeholder="Make the stop loss tighter, add MACD..."
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
        <Button type="submit" size="icon" disabled={disabled || !value.trim()}>
          <Send className="h-4 w-4" />
        </Button>
      </form>
      <Button onClick={onSave} disabled={isSaving || disabled}>
        <Save className="mr-1.5 h-3.5 w-3.5" />
        {isSaving ? "Saving..." : "Save"}
      </Button>
    </div>
  );
}

async function streamAI(
  prefs: Record<string, string>,
  history: ChatMessage[],
  onUpdate: (text: string) => void
): Promise<string> {
  const res = await fetch("/api/algorithms/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preferences: prefs, messages: history }),
  });
  if (!res.ok || !res.body) throw new Error("Generation failed");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    fullText += decoder.decode(value, { stream: true });
    onUpdate(fullText);
  }
  return fullText;
}

export default function GenerateAlgorithmPage() {
  const router = useRouter();
  const generateMutation = useGenerateAlgorithm();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [preferences, setPreferences] = useState<Record<string, string> | null>(null);
  const [refinement, setRefinement] = useState("");

  const hasStrategy = messages.some((m) => m.role === "assistant");

  async function handleStream(prefs: Record<string, string>, history: ChatMessage[]) {
    setIsStreaming(true);
    try {
      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);
      await streamAI(prefs, history, (text) => {
        setMessages((prev) => [...prev.slice(0, -1), { role: "assistant", content: text }]);
      });
    } catch {
      setMessages((prev) => [
        ...prev.slice(0, -1),
        { role: "assistant", content: "Generation failed. Please try again." },
      ]);
    } finally {
      setIsStreaming(false);
    }
  }

  async function handleGenerate(values: Record<string, string>) {
    setPreferences(values);
    setMessages([]);
    await handleStream(values, []);
  }

  async function handleRefine() {
    if (!refinement.trim() || !preferences || isStreaming) return;
    const userMsg: ChatMessage = { role: "user", content: refinement.trim() };
    const updated = [...messages, userMsg];
    setMessages(updated);
    setRefinement("");
    await handleStream(preferences, updated);
  }

  async function handleSave() {
    if (!preferences) return;
    const parsed = algorithmFormSchema.safeParse(preferences);
    if (!parsed.success) return;
    const result = await generateMutation.mutateAsync(parsed.data);
    if (result.success) {
      router.push("/algorithms");
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader />
      {!hasStrategy && <GenerateForm onSubmit={handleGenerate} disabled={isStreaming} />}
      {messages.length > 0 && (
        <div className="space-y-3">
          {messages.map((msg, i) => (
            <MessageBubble key={i} message={msg} />
          ))}
        </div>
      )}
      {hasStrategy && !isStreaming && (
        <RefineInput
          value={refinement}
          onChange={setRefinement}
          onSend={handleRefine}
          onSave={handleSave}
          disabled={isStreaming}
          isSaving={generateMutation.isPending}
        />
      )}
    </div>
  );
}
