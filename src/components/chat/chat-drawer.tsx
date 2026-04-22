"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bot, Loader2, Send } from "lucide-react";
import { generateAlgorithm } from "@/app/(dashboard)/algorithms/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { AlgorithmFormValues } from "@/lib/validators/algorithm";
import type { ChatMessage } from "@/types/chat";
import { MessageBubble } from "./message-bubble";

const ALGO_MARKER = "[CREATE_ALGORITHM]";

interface ChatDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stats: Record<string, unknown> | null;
}

function parseAlgorithmMarker(text: string): AlgorithmFormValues | null {
  const idx = text.indexOf(ALGO_MARKER);
  if (idx === -1) return null;
  const after = text.substring(idx + ALGO_MARKER.length).trim();
  const jsonMatch = after.match(/^\{[^}]+\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]) as AlgorithmFormValues;
  } catch {
    return null;
  }
}

function stripMarker(text: string): string {
  const idx = text.indexOf(ALGO_MARKER);
  if (idx === -1) return text;
  const before = text.substring(0, idx).trim();
  const after = text.substring(idx + ALGO_MARKER.length).trim();
  const afterJson = after.replace(/^\{[^}]+\}\s*/, "").trim();
  return [before, afterJson].filter(Boolean).join("\n\n");
}

function AlgorithmCreatedBanner({ algorithmId }: { algorithmId: string }) {
  return (
    <div className="mx-3 rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Bot className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">Algorithm Created</span>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="w-full"
        render={<Link href={`/algorithms/${algorithmId}`} />}
        nativeButton={false}
      >
        View Algorithm
      </Button>
    </div>
  );
}

function MessageList({
  messages,
  isStreaming,
  createdAlgoIds,
}: {
  messages: ChatMessage[];
  isStreaming: boolean;
  createdAlgoIds: string[];
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isStreaming, createdAlgoIds]);

  return (
    <div className="flex-1 overflow-y-auto space-y-3 p-4">
      {messages.length === 0 && (
        <div className="text-center mt-8 space-y-2">
          <p className="text-sm text-muted-foreground">
            Ask me anything about trading or your performance.
          </p>
          <Badge variant="outline" className="text-xs">
            Try: &quot;Create me a trading algorithm&quot;
          </Badge>
        </div>
      )}
      {messages.map((msg, i) => (
        <MessageBubble key={i} message={{ ...msg, content: stripMarker(msg.content) }} />
      ))}
      {isStreaming && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Thinking...
        </div>
      )}
      {createdAlgoIds.map((id) => (
        <AlgorithmCreatedBanner key={id} algorithmId={id} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function ChatInput({ onSend, disabled }: { onSend: (text: string) => void; disabled: boolean }) {
  const [input, setInput] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setInput("");
  }

  return (
    <form onSubmit={handleSubmit} className="border-t border-border p-3 flex gap-2">
      <Input
        placeholder="Ask about trading or create an algorithm..."
        value={input}
        onChange={(e) => setInput(e.target.value)}
        disabled={disabled}
        className="flex-1"
      />
      <Button type="submit" size="icon" disabled={disabled || !input.trim()}>
        <Send className="h-4 w-4" />
      </Button>
    </form>
  );
}

export function ChatDrawer({ open, onOpenChange, stats }: ChatDrawerProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [createdAlgoIds, setCreatedAlgoIds] = useState<string[]>([]);

  async function handleAlgorithmCreation(values: AlgorithmFormValues) {
    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: "Generating your algorithm with AI-optimized rules..." },
    ]);
    try {
      const result = await generateAlgorithm(values);
      if (result.success) {
        const algo = result.data as { id: string; name: string };
        setCreatedAlgoIds((prev) => [...prev, algo.id]);
        setMessages((prev) => [
          ...prev.slice(0, -1),
          { role: "assistant", content: `Your algorithm "${algo.name}" has been created with optimized trading rules.` },
        ]);
      } else {
        setMessages((prev) => [
          ...prev.slice(0, -1),
          { role: "assistant", content: `Algorithm creation failed: ${result.error}` },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev.slice(0, -1),
        { role: "assistant", content: "Algorithm creation failed. Please try again." },
      ]);
    }
  }

  async function handleSend(text: string) {
    const userMsg: ChatMessage = { role: "user", content: text };
    const updated = [...messages, userMsg];
    setMessages(updated);
    setIsStreaming(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: updated, stats }),
      });

      if (!res.ok || !res.body) throw new Error("Chat request failed");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = "";

      setMessages([...updated, { role: "assistant", content: "" }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        assistantText += decoder.decode(value, { stream: true });
        setMessages([...updated, { role: "assistant", content: assistantText }]);
      }

      // Check for algorithm creation marker
      const algoValues = parseAlgorithmMarker(assistantText);
      if (algoValues) {
        await handleAlgorithmCreation(algoValues);
      }
    } catch {
      setMessages([
        ...updated,
        { role: "assistant", content: "Sorry, I couldn't process that. Please try again." },
      ]);
    } finally {
      setIsStreaming(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col p-0 sm:max-w-sm">
        <SheetHeader className="border-b border-border px-4 py-3 pr-12 flex flex-row items-center justify-between">
          <SheetTitle className="text-sm">AI Assistant</SheetTitle>
          {messages.length > 0 && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => { setMessages([]); setCreatedAlgoIds([]); }}
              disabled={isStreaming}
            >
              New Chat
            </Button>
          )}
        </SheetHeader>
        <MessageList messages={messages} isStreaming={isStreaming} createdAlgoIds={createdAlgoIds} />
        <ChatInput onSend={handleSend} disabled={isStreaming} />
      </SheetContent>
    </Sheet>
  );
}
