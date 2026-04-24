import Papa from "papaparse";

interface RawCsvRow {
  Action: string;
  Time: string;
  ISIN: string;
  Ticker: string;
  Name: string;
  "No. of shares": string;
  "Price / share": string;
  "Currency (Price / share)": string;
  "Exchange rate": string;
  Result: string;
  "Currency (Result)": string;
  Total: string;
  "Currency (Total)": string;
}

interface ParsedTrade {
  action: "buy" | "sell";
  ticker: string;
  name: string;
  date: string;
  shares: number;
  pricePerShare: number;
  priceCurrency: string;
  totalGbp: number;
  resultGbp: number | null;
}

interface TickerSummary {
  name: string;
  totalBought: number;
  totalSold: number;
  pnl: number;
  buyCount: number;
  sellCount: number;
  firstBuyDate: string;
  lastSellDate: string | null;
  holdDays: number | null;
  sharesRemaining: number;
}

export interface CsvParseResult {
  analysisText: string;
  tradeCount: number;
  symbolCount: number;
  tickers: { symbol: string; name: string }[];
}

function parseAction(action: string): "buy" | "sell" | null {
  const lower = action.toLowerCase();
  if (lower.includes("buy")) {
    return "buy";
  }
  if (lower.includes("sell")) {
    return "sell";
  }
  return null;
}

function daysBetween(a: string, b: string): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / msPerDay);
}

function fmt(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}`;
}

function parseTrades(rows: RawCsvRow[]): ParsedTrade[] {
  const trades: ParsedTrade[] = [];
  for (const row of rows) {
    const action = parseAction(row.Action);
    if (!action || !row.Ticker) {
      continue;
    }
    const shares = parseFloat(row["No. of shares"]);
    const price = parseFloat(row["Price / share"]);
    const total = parseFloat(row.Total);
    const result = row.Result ? parseFloat(row.Result) : null;
    if (isNaN(shares) || isNaN(price) || isNaN(total)) {
      continue;
    }
    trades.push({
      action,
      ticker: row.Ticker.trim(),
      name: row.Name?.trim() ?? row.Ticker.trim(),
      date: row.Time?.split(" ")[0] ?? "",
      shares,
      pricePerShare: price,
      priceCurrency: row["Currency (Price / share)"] ?? "USD",
      totalGbp: total,
      resultGbp: result !== null && !isNaN(result) ? result : null,
    });
  }
  return trades;
}

function buildTickerSummaries(trades: ParsedTrade[]): Record<string, TickerSummary> {
  const byTicker: Record<string, TickerSummary> = {};
  for (const t of trades) {
    if (!byTicker[t.ticker]) {
      byTicker[t.ticker] = {
        name: t.name,
        totalBought: 0,
        totalSold: 0,
        pnl: 0,
        buyCount: 0,
        sellCount: 0,
        firstBuyDate: t.date,
        lastSellDate: null,
        holdDays: null,
        sharesRemaining: 0,
      };
    }
    const s = byTicker[t.ticker];
    if (t.action === "buy") {
      s.totalBought += t.totalGbp;
      s.buyCount++;
      s.sharesRemaining += t.shares;
      if (!s.firstBuyDate || t.date < s.firstBuyDate) {
        s.firstBuyDate = t.date;
      }
    } else {
      s.totalSold += t.totalGbp;
      s.sellCount++;
      s.sharesRemaining -= t.shares;
      if (t.resultGbp !== null) {
        s.pnl += t.resultGbp;
      }
      if (!s.lastSellDate || t.date > s.lastSellDate) {
        s.lastSellDate = t.date;
      }
    }
  }
  for (const s of Object.values(byTicker)) {
    if (s.lastSellDate && s.firstBuyDate) {
      s.holdDays = daysBetween(s.firstBuyDate, s.lastSellDate);
    }
    if (Math.abs(s.sharesRemaining) < 0.001) {
      s.sharesRemaining = 0;
    }
  }
  return byTicker;
}

function buildPositionsText(byTicker: Record<string, TickerSummary>): string[] {
  const lines: string[] = [];
  const closed = Object.entries(byTicker).filter(([, s]) => s.sellCount > 0);
  if (closed.length > 0) {
    lines.push("CLOSED POSITIONS:");
    closed.sort(([, a], [, b]) => b.pnl - a.pnl);
    for (const [ticker, s] of closed) {
      const hold = s.holdDays !== null ? `, ${s.holdDays}d hold` : "";
      const partial = s.sharesRemaining > 0.001 ? " (partially closed)" : "";
      const pctReturn = s.totalBought > 0 ? ((s.pnl / s.totalBought) * 100).toFixed(0) : "0";
      lines.push(
        `- ${ticker} (${s.name}): P&L: ${fmt(s.pnl)} GBP (${pctReturn}% return), invested: ${s.totalBought.toFixed(0)} GBP${hold}${partial}`
      );
    }
    lines.push("");
  }
  const open = Object.entries(byTicker).filter(([, s]) => s.sharesRemaining > 0.001);
  if (open.length > 0) {
    lines.push("OPEN POSITIONS:");
    for (const [ticker, s] of open) {
      lines.push(
        `- ${ticker} (${s.name}): ${s.sharesRemaining.toFixed(4)} shares, invested: ${s.totalBought.toFixed(2)} GBP`
      );
    }
    lines.push("");
  }
  return lines;
}

function buildSummaryText(
  trades: ParsedTrade[],
  byTicker: Record<string, TickerSummary>
): string[] {
  const sells = trades.filter((t) => t.action === "sell" && t.resultGbp !== null);
  const totalPnl = sells.reduce((sum, t) => sum + (t.resultGbp ?? 0), 0);
  const winners = sells.filter((t) => (t.resultGbp ?? 0) > 0);
  const losers = sells.filter((t) => (t.resultGbp ?? 0) < 0);
  const winRate = sells.length > 0 ? ((winners.length / sells.length) * 100).toFixed(0) : "0";
  const lines = [
    "SUMMARY:",
    `- Total P&L: ${fmt(totalPnl)} GBP`,
    `- ${winners.length} winning sells, ${losers.length} losing sells (${winRate}% win rate)`,
  ];
  if (winners.length > 0) {
    lines.push(
      `- Average win: ${fmt(winners.reduce((s, t) => s + (t.resultGbp ?? 0), 0) / winners.length)} GBP`
    );
  }
  if (losers.length > 0) {
    lines.push(
      `- Average loss: ${fmt(losers.reduce((s, t) => s + (t.resultGbp ?? 0), 0) / losers.length)} GBP`
    );
  }
  const tickerPnls = Object.entries(byTicker)
    .filter(([, s]) => s.sellCount > 0)
    .map(([ticker, s]) => ({ ticker, pnl: s.pnl }));
  const best = tickerPnls.reduce<{ ticker: string; pnl: number } | null>(
    (b, t) => (!b || t.pnl > b.pnl ? t : b),
    null
  );
  const worst = tickerPnls.reduce<{ ticker: string; pnl: number } | null>(
    (w, t) => (!w || t.pnl < w.pnl ? t : w),
    null
  );
  if (best) {
    lines.push(`- Best position: ${best.ticker} ${fmt(best.pnl)} GBP`);
  }
  if (worst && worst.pnl < 0) {
    lines.push(`- Worst position: ${worst.ticker} ${fmt(worst.pnl)} GBP`);
  }
  lines.push(`- Symbols traded: ${Object.keys(byTicker).join(", ")}`);

  // Calculate % returns per closed position for risk profile
  const closedTickers = Object.entries(byTicker).filter(
    ([, s]) => s.sellCount > 0 && s.totalBought > 0
  );
  const pctReturns = closedTickers.map(([, s]) => (s.pnl / s.totalBought) * 100);
  const winReturns = pctReturns.filter((r) => r > 0);
  const lossReturns = pctReturns.filter((r) => r < 0);
  if (pctReturns.length > 0) {
    lines.push("");
    lines.push(
      "RISK PROFILE (derived from actual trades — use these to set algorithm parameters):"
    );
    if (winReturns.length > 0) {
      const avgWinPct = winReturns.reduce((a, b) => a + b, 0) / winReturns.length;
      const maxWinPct = Math.max(...winReturns);
      lines.push(
        `- Average winning return: ${avgWinPct.toFixed(0)}%, best: ${maxWinPct.toFixed(0)}%`
      );
      lines.push(
        `- Suggested take_profit: ${Math.round(avgWinPct * 0.5)}-${Math.round(avgWinPct * 0.75)}% (capture most of avg win)`
      );
    }
    if (lossReturns.length > 0) {
      const avgLossPct = lossReturns.reduce((a, b) => a + b, 0) / lossReturns.length;
      lines.push(
        `- Average losing return: ${avgLossPct.toFixed(0)}% (user held through this — no stop losses used)`
      );
      lines.push(
        `- Suggested stop_loss: ${Math.round(Math.abs(avgLossPct) * 0.3)}-${Math.round(Math.abs(avgLossPct) * 0.5)}% (cut losses much earlier than actual)`
      );
    }
    const avgHold = closedTickers
      .filter(([, s]) => s.holdDays !== null)
      .map(([, s]) => s.holdDays!);
    if (avgHold.length > 0) {
      lines.push(
        `- Average hold: ${Math.round(avgHold.reduce((a, b) => a + b, 0) / avgHold.length)} days`
      );
    }
  }
  return lines;
}

function buildAnalysisText(
  trades: ParsedTrade[],
  byTicker: Record<string, TickerSummary>,
  dateRange: { from: string; to: string }
): string {
  const header = `Trade History (${dateRange.from} to ${dateRange.to}), currency: GBP`;
  return [header, "", ...buildPositionsText(byTicker), ...buildSummaryText(trades, byTicker)].join(
    "\n"
  );
}

export function parseTradeHistoryCsv(file: File): Promise<CsvParseResult> {
  return new Promise((resolve, reject) => {
    Papa.parse<RawCsvRow>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const trades = parseTrades(results.data);
        if (trades.length === 0) {
          reject(new Error("No valid trades found in CSV"));
          return;
        }
        const byTicker = buildTickerSummaries(trades);
        const dates = trades
          .map((t) => t.date)
          .filter(Boolean)
          .sort();
        const dateRange = { from: dates[0] ?? "", to: dates[dates.length - 1] ?? "" };
        resolve({
          analysisText: buildAnalysisText(trades, byTicker, dateRange),
          tradeCount: trades.length,
          symbolCount: Object.keys(byTicker).length,
          tickers: Object.entries(byTicker).map(([symbol, summary]) => ({
            symbol,
            name: summary.name,
          })),
        });
      },
      error: (err: Error) => reject(err),
    });
  });
}
