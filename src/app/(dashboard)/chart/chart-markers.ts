/**
 * Trade-marker fetchers split from chart/actions.ts. Each returns an
 * array of ChartMarker entries (entry + exit pairs) ready to ship to
 * the client. Split so the actions file stays under the max-lines lint.
 */
import type { ChartMarker } from "./actions";

type Supa = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any;
};

function isoToUnixSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function computeR(
  side: "long" | "short",
  entry: number,
  stop: number | null,
  exit: number
): number | null {
  if (stop == null) return null;
  const rDistance = Math.abs(entry - stop);
  if (rDistance === 0) return null;
  const move = side === "long" ? exit - entry : entry - exit;
  return move / rDistance;
}

export async function fetchPaperMarkers(
  supabase: Supa,
  ticker: string,
  sinceIso: string,
  algorithmId: string | null
): Promise<ChartMarker[]> {
  let query = supabase
    .from("paper_positions")
    .select(
      "side, entry_price, exit_price, opened_at, closed_at, initial_stop_loss_price, stop_loss_price, realized_pnl, status"
    )
    .eq("ticker", ticker)
    .gte("opened_at", sinceIso)
    .order("opened_at", { ascending: true });
  if (algorithmId) query = query.eq("algorithm_id", algorithmId);
  const { data, error } = await query;
  if (error) return [];
  const rows = (data ?? []) as Array<{
    side: string;
    entry_price: number;
    exit_price: number | null;
    opened_at: string;
    closed_at: string | null;
    initial_stop_loss_price: number | null;
    stop_loss_price: number | null;
    realized_pnl: number | null;
    status: string;
  }>;

  const markers: ChartMarker[] = [];
  for (const p of rows) {
    if (p.side !== "long" && p.side !== "short") continue;
    const side = p.side;
    markers.push({
      time: isoToUnixSeconds(p.opened_at),
      side,
      kind: "entry",
      price: p.entry_price,
      r_multiple: null,
      label: `${side} entry @ ${p.entry_price.toFixed(5)}`,
    });
    if (p.closed_at && p.exit_price != null) {
      const stop = p.initial_stop_loss_price ?? p.stop_loss_price;
      const r = computeR(side, p.entry_price, stop, p.exit_price);
      markers.push({
        time: isoToUnixSeconds(p.closed_at),
        side,
        kind: "exit",
        price: p.exit_price,
        r_multiple: r,
        label: `${side} exit @ ${p.exit_price.toFixed(5)}${r != null ? ` (${r >= 0 ? "+" : ""}${r.toFixed(2)}R)` : ""}`,
      });
    }
  }
  return markers;
}

export async function fetchBacktestMarkers(
  supabase: Supa,
  ticker: string,
  sinceIso: string,
  algorithmId: string | null
): Promise<ChartMarker[]> {
  if (!algorithmId) return [];
  const { data, error } = await supabase
    .from("backtest_trades")
    .select("side, entry_date, exit_date, entry_price, exit_price, pnl, r_multiple")
    .eq("algorithm_id", algorithmId)
    .eq("ticker", ticker)
    .gte("entry_date", sinceIso)
    .order("entry_date", { ascending: true })
    .limit(2000);
  if (error) return [];
  const rows = (data ?? []) as Array<{
    side: "long" | "short";
    entry_date: string;
    exit_date: string;
    entry_price: number | string;
    exit_price: number | string;
    pnl: number | string;
    r_multiple: number | string | null;
  }>;
  const markers: ChartMarker[] = [];
  for (const t of rows) {
    const entry = Number(t.entry_price);
    const exit = Number(t.exit_price);
    const r = t.r_multiple != null ? Number(t.r_multiple) : null;
    markers.push({
      time: isoToUnixSeconds(t.entry_date),
      side: t.side,
      kind: "entry",
      price: entry,
      r_multiple: null,
      label: `${t.side} entry @ ${entry.toFixed(5)}`,
    });
    markers.push({
      time: isoToUnixSeconds(t.exit_date),
      side: t.side,
      kind: "exit",
      price: exit,
      r_multiple: r,
      label: `${t.side} exit @ ${exit.toFixed(5)}${r != null ? ` (${r >= 0 ? "+" : ""}${r.toFixed(2)}R)` : ""}`,
    });
  }
  return markers;
}
