"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { ChatMessage } from "@/types/chat";
import { MessageBubble } from "./message-bubble";

interface ChatDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stats: Record<string, unknown> | null;
}

function MessageList({ messages, isStreaming }: { messages: ChatMessage[]; isStreaming: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isStreaming]);

  return (
    <div className="flex-1 overflow-y-auto space-y-3 p-4">
      {messages.length === 0 && (
        <p className="text-sm text-muted-foreground text-center mt-8">
          Ask me anything about trading or your performance.
        </p>
      )}
      {messages.map((msg, i) => (
        <MessageBubble key={i} message={msg} />
      ))}
      {isStreaming && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Thinking...
        </div>
      )}
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
        placeholder="Ask about trading..."
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

      if (!res.ok || !res.body) {
        throw new Error("Chat request failed");
      }

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
        <SheetHeader className="border-b border-border px-4 py-3">
          <SheetTitle className="text-sm">AI Assistant</SheetTitle>
        </SheetHeader>
        <MessageList messages={messages} isStreaming={isStreaming} />
        <ChatInput onSend={handleSend} disabled={isStreaming} />
      </SheetContent>
    </Sheet>
  );
}
