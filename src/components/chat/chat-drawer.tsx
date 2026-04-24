"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { Bot, Loader2, Paperclip } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { stripMarker, useChat } from "@/hooks/use-chat";
import type { ChatMessage } from "@/types/chat";
import { ChatInput } from "./chat-input";
import { MessageBubble } from "./message-bubble";

interface ChatDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stats: Record<string, unknown> | null;
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
        <div className="text-center mt-8 space-y-3">
          <p className="text-sm text-muted-foreground">
            Ask me anything about trading or your performance.
          </p>
          <div className="flex flex-col items-center gap-1.5">
            <Badge variant="outline" className="text-xs">
              Try: &quot;Create me a trading algorithm&quot;
            </Badge>
            <Badge variant="outline" className="text-xs">
              Or: Upload a trade history CSV with the <Paperclip className="inline h-3 w-3" />{" "}
              button
            </Badge>
          </div>
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

export function ChatDrawer({ open, onOpenChange, stats }: ChatDrawerProps) {
  const chat = useChat(stats);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col p-0 sm:max-w-sm">
        <SheetHeader className="border-b border-border px-4 py-3 pr-12 flex flex-row items-center justify-between">
          <SheetTitle className="text-sm">AI Assistant</SheetTitle>
          {chat.messages.length > 0 && (
            <Button
              variant="ghost"
              size="xs"
              onClick={chat.handleNewChat}
              disabled={chat.isStreaming}
            >
              New Chat
            </Button>
          )}
        </SheetHeader>
        <MessageList
          messages={chat.messages}
          isStreaming={chat.isStreaming}
          createdAlgoIds={chat.createdAlgoIds}
        />
        <ChatInput
          onSend={chat.handleSend}
          disabled={chat.isStreaming}
          onFileSelect={chat.handleFileSelect}
          attachedFile={chat.attachedFileName}
          onRemoveFile={chat.handleRemoveFile}
          isParsing={chat.isParsing}
        />
      </SheetContent>
    </Sheet>
  );
}
