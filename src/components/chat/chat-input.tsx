"use client";

import { useRef, useState } from "react";
import { FileSpreadsheet, Loader2, Paperclip, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function CsvAttachment({ fileName, onRemove }: { fileName: string; onRemove: () => void }) {
  return (
    <div className="mx-3 mb-0 flex items-center gap-2 rounded-t-lg border border-b-0 border-border bg-muted/50 px-3 py-1.5">
      <FileSpreadsheet className="h-3.5 w-3.5 text-primary" />
      <span className="flex-1 truncate text-xs font-medium">{fileName}</span>
      <button
        type="button"
        onClick={onRemove}
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export interface ChatInputProps {
  onSend: (text: string) => void;
  disabled: boolean;
  onFileSelect: (file: File) => void;
  attachedFile: string | null;
  onRemoveFile: () => void;
  isParsing: boolean;
}

export function ChatInput({
  onSend,
  disabled,
  onFileSelect,
  attachedFile,
  onRemoveFile,
  isParsing,
}: ChatInputProps) {
  const [input, setInput] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setInput("");
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      onFileSelect(file);
    }
    if (fileRef.current) {
      fileRef.current.value = "";
    }
  }

  return (
    <div>
      {attachedFile && <CsvAttachment fileName={attachedFile} onRemove={onRemoveFile} />}
      {isParsing && (
        <div className="mx-3 mb-0 flex items-center gap-2 rounded-t-lg border border-b-0 border-border bg-muted/50 px-3 py-1.5">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          <span className="text-xs text-muted-foreground">Parsing trade history...</span>
        </div>
      )}
      <form onSubmit={handleSubmit} className="border-t border-border p-3 flex gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled || isParsing}
          onClick={() => fileRef.current?.click()}
          title="Upload trade history CSV"
        >
          <Paperclip className="h-4 w-4" />
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={handleFileChange}
        />
        <Input
          placeholder={
            attachedFile
              ? "Ask about your trade history..."
              : "Ask about trading or create an algorithm..."
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={disabled}
          className="flex-1"
        />
        <Button type="submit" size="icon" disabled={disabled || !input.trim()}>
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}
