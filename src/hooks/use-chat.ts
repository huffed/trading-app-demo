import { useState } from "react";
import { generateAlgorithm } from "@/app/(dashboard)/algorithms/actions";
import { seedWatchlist } from "@/app/(dashboard)/algorithms/seed-watchlist-action";
import { bulkAddWatchlistItems } from "@/app/(dashboard)/algorithms/watchlist-actions";
import { parseTradeHistoryCsv } from "@/lib/utils/parse-trade-csv";
import type { AlgorithmFormValues } from "@/lib/validators/algorithm";
import type { ChatMessage } from "@/types/chat";

const ALGO_MARKER = "[CREATE_ALGORITHM]";

export function parseAlgorithmMarker(text: string): AlgorithmFormValues | null {
  const idx = text.indexOf(ALGO_MARKER);
  if (idx === -1) { return null; }
  const after = text.substring(idx + ALGO_MARKER.length).trim();
  const jsonMatch = after.match(/^\{[^}]+\}/);
  if (!jsonMatch) { return null; }
  try {
    return JSON.parse(jsonMatch[0]) as AlgorithmFormValues;
  } catch {
    return null;
  }
}

export function stripMarker(text: string): string {
  const idx = text.indexOf(ALGO_MARKER);
  if (idx === -1) { return text; }
  const before = text.substring(0, idx).trim();
  const after = text.substring(idx + ALGO_MARKER.length).trim();
  const afterJson = after.replace(/^\{[^}]+\}\s*/, "").trim();
  return [before, afterJson].filter(Boolean).join("\n\n");
}

async function createAlgorithm(
  values: AlgorithmFormValues,
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  setCreatedAlgoIds: React.Dispatch<React.SetStateAction<string[]>>,
  tickers?: { symbol: string; name: string }[] | null
) {
  setMessages((p) => [...p, { role: "assistant", content: "Generating your algorithm with AI-optimized rules..." }]);
  try {
    const result = await generateAlgorithm(values);
    if (!result.success) {
      setMessages((p) => [...p.slice(0, -1), { role: "assistant", content: `Algorithm creation failed: ${result.error}` }]);
      return;
    }
    const algo = result.data as { id: string; name: string };
    setCreatedAlgoIds((p) => [...p, algo.id]);

    // Add CSV tickers to watchlist
    if (tickers && tickers.length > 0) {
      bulkAddWatchlistItems(algo.id, tickers, "csv").catch(() => {});
    }

    // Discover + backtest + add profitable tickers
    setMessages((p) => [...p.slice(0, -1), {
      role: "assistant",
      content: `Your algorithm "${algo.name}" has been created. Now discovering and screening tickers...`,
    }]);

    const seed = await seedWatchlist(algo.id);
    if (seed.success && seed.data.added > 0) {
      const profitable = seed.data.tickers.filter((t) => t.profitable);
      const tickerList = profitable.map((t) => t.ticker).join(", ");
      setMessages((p) => [...p.slice(0, -1), {
        role: "assistant",
        content: `Your algorithm "${algo.name}" is ready. Screened ${seed.data.tickers.length} tickers — ${seed.data.added} were profitable in backtesting and added to the watchlist: ${tickerList}`,
      }]);
    } else {
      setMessages((p) => [...p.slice(0, -1), {
        role: "assistant",
        content: `Your algorithm "${algo.name}" has been created with optimized trading rules.`,
      }]);
    }
  } catch {
    setMessages((p) => [...p.slice(0, -1), { role: "assistant", content: "Algorithm creation failed. Please try again." }]);
  }
}

export function useChat(stats: Record<string, unknown> | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [createdAlgoIds, setCreatedAlgoIds] = useState<string[]>([]);
  const [tradeHistory, setTradeHistory] = useState<string | null>(null);
  const [parsedTickers, setParsedTickers] = useState<{ symbol: string; name: string }[] | null>(null);
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
      if (!res.ok || !res.body) { throw new Error("Chat request failed"); }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = "";
      setMessages([...updated, { role: "assistant", content: "" }]);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { break; }
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
      const algoValues = parseAlgorithmMarker(assistantText);
      if (algoValues) { await createAlgorithm(algoValues, setMessages, setCreatedAlgoIds, parsedTickers); }
    } catch {
      setMessages([...updated, { role: "assistant", content: "Sorry, I couldn't process that. Please try again." }]);
    } finally {
      setIsStreaming(false);
    }
  }

  async function handleFileSelect(file: File) {
    if (!file.name.endsWith(".csv")) { return; }
    setIsParsing(true);
    try {
      const result = await parseTradeHistoryCsv(file);
      setTradeHistory(result.analysisText);
      setParsedTickers(result.tickers);
      setAttachedFileName(file.name);
      const msg = `I've uploaded my trade history (${result.tradeCount} trades, ${result.symbolCount} symbols). Analyze my trading patterns and tell me what you find.`;
      handleSend(msg, result.analysisText);
    } catch {
      setMessages((p) => [...p, { role: "assistant", content: "I couldn't parse that CSV file. Make sure it's a valid trade history export (e.g., from Trading 212)." }]);
    } finally {
      setIsParsing(false);
    }
  }

  function handleNewChat() {
    setMessages([]);
    setCreatedAlgoIds([]);
    setTradeHistory(null);
    setParsedTickers(null);
    setAttachedFileName(null);
  }

  return {
    messages, isStreaming, createdAlgoIds, attachedFileName, isParsing,
    handleSend, handleFileSelect, handleNewChat,
    handleRemoveFile: () => { setTradeHistory(null); setAttachedFileName(null); },
  };
}
