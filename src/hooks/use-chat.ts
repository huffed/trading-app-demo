/**
 * Chat hook — manages the AI chat conversation for algorithm creation/editing.
 *
 * The LLM uses special markers in its response to trigger actions:
 * - [CREATE_ALGORITHM]{...json...} → creates a new algorithm via server action
 * - [EDIT_ALGORITHM]{...json...}   → updates an existing algorithm
 *
 * After creating an algorithm, the hook automatically:
 * 1. Seeds the watchlist with CSV-parsed tickers (if CSV was uploaded)
 * 2. Runs discovery + backtesting via seedWatchlist()
 * 3. Reports results back in the chat
 *
 * The marker text is stripped from the displayed message via stripMarker().
 */
import { useState } from "react";
import { z } from "zod";
import { generateAlgorithm, updateAlgorithm } from "@/app/(dashboard)/algorithms/actions";
import { seedWatchlist } from "@/app/(dashboard)/algorithms/seed-watchlist-action";
import { bulkAddWatchlistItems } from "@/app/(dashboard)/algorithms/watchlist-actions";
import { parseTradeHistoryCsv } from "@/lib/utils/parse-trade-csv";
import {
  algorithmFormSchema,
  algorithmUpdateSchema,
  type AlgorithmFormValues,
  type AlgorithmUpdate,
} from "@/lib/validators/algorithm";
import type { ChatMessage } from "@/types/chat";

const ALGO_MARKER = "[CREATE_ALGORITHM]";
const EDIT_MARKER = "[EDIT_ALGORITHM]";

const editMarkerSchema = z.object({
  id: z.string().min(1),
  updates: algorithmUpdateSchema,
});

/**
 * Find the first balanced JSON object in `text` starting at or after `from`.
 * Tracks string state so braces inside quoted values don't unbalance the
 * scanner — the previous regex-based approach failed on nested objects
 * (e.g. updates.rules.entry_conditions[0]) which the LLM emits routinely.
 */
function extractFirstJsonObject(text: string, from = 0): { start: number; end: number } | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        return { start, end: i + 1 };
      }
    }
  }
  return null;
}

function parseMarkerJson(text: string, marker: string): { json: string; end: number } | null {
  const idx = text.indexOf(marker);
  if (idx === -1) return null;
  const range = extractFirstJsonObject(text, idx + marker.length);
  if (!range) return null;
  return { json: text.slice(range.start, range.end), end: range.end };
}

export function parseAlgorithmMarker(text: string): AlgorithmFormValues | null {
  const marker = parseMarkerJson(text, ALGO_MARKER);
  if (!marker) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(marker.json);
  } catch {
    return null;
  }
  const parsed = algorithmFormSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function parseEditMarker(text: string): { id: string; updates: AlgorithmUpdate } | null {
  const marker = parseMarkerJson(text, EDIT_MARKER);
  if (!marker) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(marker.json);
  } catch {
    return null;
  }
  const parsed = editMarkerSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function stripMarker(text: string): string {
  let result = text;
  for (const marker of [ALGO_MARKER, EDIT_MARKER]) {
    const idx = result.indexOf(marker);
    if (idx === -1) continue;
    const range = extractFirstJsonObject(result, idx + marker.length);
    const before = result.slice(0, idx).trim();
    const after = range ? result.slice(range.end).trim() : "";
    result = [before, after].filter(Boolean).join("\n\n");
  }
  return result;
}

async function createAlgorithm(
  values: AlgorithmFormValues,
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  setCreatedAlgoIds: React.Dispatch<React.SetStateAction<string[]>>,
  tickers?: { symbol: string; name: string }[] | null
) {
  setMessages((p) => [
    ...p,
    { role: "assistant", content: "Generating your algorithm with AI-optimized rules..." },
  ]);
  try {
    const result = await generateAlgorithm(values);
    if (!result.success) {
      setMessages((p) => [
        ...p.slice(0, -1),
        { role: "assistant", content: `Algorithm creation failed: ${result.error}` },
      ]);
      return;
    }
    setCreatedAlgoIds((p) => [...p, result.data.id]);

    const algoName = result.data.name;

    // Add CSV tickers to watchlist
    if (tickers && tickers.length > 0) {
      bulkAddWatchlistItems(result.data.id, tickers, "csv").catch((e) =>
        console.warn("[watchlist] Failed to seed CSV tickers:", e instanceof Error ? e.message : e)
      );
    }

    // Discover + backtest + add profitable tickers
    setMessages((p) => [
      ...p.slice(0, -1),
      {
        role: "assistant",
        content: `Your algorithm "${algoName}" has been created. Now discovering and screening tickers...`,
      },
    ]);

    const seed = await seedWatchlist(result.data.id);
    if (seed.success && seed.data.added > 0) {
      const profitable = seed.data.tickers.filter((t) => t.profitable);
      const tickerList = profitable.map((t) => t.ticker).join(", ");
      setMessages((p) => [
        ...p.slice(0, -1),
        {
          role: "assistant",
          content: `Your algorithm "${algoName}" is ready. Screened ${seed.data.tickers.length} tickers — ${seed.data.added} were profitable in backtesting and added to the watchlist: ${tickerList}`,
        },
      ]);
    } else {
      setMessages((p) => [
        ...p.slice(0, -1),
        {
          role: "assistant",
          content: `Your algorithm "${algoName}" has been created with optimized trading rules.`,
        },
      ]);
    }
  } catch {
    setMessages((p) => [
      ...p.slice(0, -1),
      { role: "assistant", content: "Algorithm creation failed. Please try again." },
    ]);
  }
}

async function editAlgorithm(
  data: { id: string; updates: AlgorithmUpdate },
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
) {
  setMessages((p) => [...p.slice(0, -1), { role: "assistant", content: "Applying changes..." }]);
  try {
    const result = await updateAlgorithm(data.id, data.updates, "chat");
    if (result.success) {
      setMessages((p) => [
        ...p.slice(0, -1),
        { role: "assistant", content: `"${result.data.name}" has been updated.` },
      ]);
    } else {
      setMessages((p) => [
        ...p.slice(0, -1),
        { role: "assistant", content: `Update failed: ${result.error}` },
      ]);
    }
  } catch {
    setMessages((p) => [
      ...p.slice(0, -1),
      { role: "assistant", content: "Failed to apply changes. Please try again." },
    ]);
  }
}

async function streamResponse(
  res: Response,
  updated: ChatMessage[],
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let assistantText = "";
  setMessages([...updated, { role: "assistant", content: "" }]);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      assistantText += decoder.decode(value, { stream: true });
      setMessages((prev) => {
        const copy = [...prev];
        copy[copy.length - 1] = { role: "assistant", content: assistantText };
        return copy;
      });
    }
  } finally {
    reader.cancel();
  }
  return assistantText;
}

async function processResponse(
  assistantText: string,
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  setCreatedAlgoIds: React.Dispatch<React.SetStateAction<string[]>>,
  parsedTickers: { symbol: string; name: string }[] | null
) {
  const algoValues = parseAlgorithmMarker(assistantText);
  if (algoValues) {
    await createAlgorithm(algoValues, setMessages, setCreatedAlgoIds, parsedTickers);
  } else {
    const editData = parseEditMarker(assistantText);
    if (editData) await editAlgorithm(editData, setMessages);
  }
}

export function useChat(stats: Record<string, unknown> | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [createdAlgoIds, setCreatedAlgoIds] = useState<string[]>([]);
  const [tradeHistory, setTradeHistory] = useState<string | null>(null);
  const [parsedTickers, setParsedTickers] = useState<{ symbol: string; name: string }[] | null>(
    null
  );
  const [attachedFileName, setAttachedFileName] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);

  async function handleSend(text: string, historyOverride?: string | null) {
    const history = historyOverride !== undefined ? historyOverride : tradeHistory;
    const userMsg: ChatMessage = { role: "user", content: text };
    const updated = [...messages, userMsg];
    setMessages(updated);
    setIsStreaming(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: updated, stats, tradeHistory: history }),
      });
      if (!res.ok || !res.body) {
        throw new Error("Chat request failed");
      }
      const assistantText = await streamResponse(res, updated, setMessages);
      await processResponse(assistantText, setMessages, setCreatedAlgoIds, parsedTickers);
    } catch {
      setMessages([
        ...updated,
        { role: "assistant", content: "Sorry, I couldn't process that. Please try again." },
      ]);
    } finally {
      setIsStreaming(false);
    }
  }

  async function handleFileSelect(file: File) {
    if (!file.name.endsWith(".csv")) return;
    setIsParsing(true);
    try {
      const result = await parseTradeHistoryCsv(file);
      setTradeHistory(result.analysisText);
      setParsedTickers(result.tickers);
      setAttachedFileName(file.name);
      const msg = `I've uploaded my trade history (${result.tradeCount} trades, ${result.symbolCount} symbols). Analyze my trading patterns and tell me what you find.`;
      handleSend(msg, result.analysisText);
    } catch {
      setMessages((p) => [
        ...p,
        {
          role: "assistant",
          content:
            "I couldn't parse that CSV file. Make sure it's a valid trade history export (e.g., from Trading 212).",
        },
      ]);
    } finally {
      setIsParsing(false);
    }
  }

  return {
    messages,
    isStreaming,
    createdAlgoIds,
    attachedFileName,
    isParsing,
    handleSend,
    handleFileSelect,
    handleNewChat: () => {
      setMessages([]);
      setCreatedAlgoIds([]);
      setTradeHistory(null);
      setParsedTickers(null);
      setAttachedFileName(null);
    },
    handleRemoveFile: () => {
      setTradeHistory(null);
      setAttachedFileName(null);
    },
  };
}
