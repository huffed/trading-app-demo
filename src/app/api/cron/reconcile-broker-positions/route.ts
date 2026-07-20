/**
 * Cron entrypoint: reconcile open paper_positions against the broker's
 * actual positions for every algorithm with live trading enabled. Drift
 * happens when:
 *   - A paper position was opened but the broker rejected/dropped the
 *     mirror (paper-only orphan, no broker_position_id).
 *   - A broker position exists with no matching paper row (the operator
 *     manually opened one outside the algorithm, or a stale row survived).
 *   - Both sides match by id but volume/symbol/side disagree (partial
 *     fill, broker re-pricing, manual edit).
 *
 * Action is passive surveillance: log + write activity_log row with
 * event_type "broker_reconciliation_drift". No auto-flatten, no auto-
 * close — that's the operator's call. The audit row gives them the data
 * to reconcile by hand.
 *
 * Auth: Bearer ${CRON_SECRET}.
 *
 * Recommended crontab (daily at 21:00 UTC = end of NY session):
 *   0 21 * * * curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
 *     "http://localhost:3000/api/cron/reconcile-broker-positions"
 */
import { NextResponse } from "next/server";
import { verifyAdminAuth } from "@/lib/api/admin-auth";
import { getBrokerAdapter } from "@/lib/brokers/registry";
import type { BrokerPosition } from "@/lib/brokers/types";
import { logger } from "@/lib/logger";
import { getContractSize } from "@/lib/constants/markets";
import { logActivity } from "@/lib/scan/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/database.types";
import { brokerConnectionFromRow } from "@/lib/supabase/row-mappers";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const VOLUME_TOLERANCE = 0.005; // 0.5% — covers floating-point + minor partial-fill rounding

type AlgoRow = Pick<Tables<"algorithms">, "id" | "user_id" | "name"> & {
  // Non-null by query invariant: .not("broker_connection_id", "is", null)
  broker_connection_id: string;
};

type PaperPositionRow = Pick<
  Tables<"paper_positions">,
  "id" | "ticker" | "quantity" | "broker_position_id"
> & {
  side: "long" | "short";
};

type DriftEntry =
  | {
      kind: "paper_only";
      paper_position_id: string;
      ticker: string;
      side: string;
      quantity: number;
      reason: string;
    }
  | {
      kind: "broker_only";
      broker_position_id: string;
      symbol: string;
      side: string;
      volume: number;
    }
  | {
      kind: "volume_drift";
      paper_position_id: string;
      broker_position_id: string;
      paper_quantity: number;
      paper_lots: number;
      broker_volume: number;
      drift_pct: number;
    }
  | {
      kind: "side_mismatch";
      paper_position_id: string;
      broker_position_id: string;
      paper_side: string;
      broker_side: string;
    };

function computeDrift(
  paper: PaperPositionRow[],
  brokerPositions: BrokerPosition[]
): DriftEntry[] {
  const drift: DriftEntry[] = [];
  const matched = new Set<string>();
  for (const p of paper) {
    if (!p.broker_position_id) {
      drift.push({
        kind: "paper_only",
        paper_position_id: p.id,
        ticker: p.ticker,
        side: p.side,
        quantity: p.quantity,
        reason: "paper position has no broker_position_id — broker mirror never landed",
      });
      continue;
    }
    const match = brokerPositions.find((b) => String(b.id) === p.broker_position_id);
    if (!match) {
      drift.push({
        kind: "paper_only",
        paper_position_id: p.id,
        ticker: p.ticker,
        side: p.side,
        quantity: p.quantity,
        reason: `broker has no position with id ${p.broker_position_id}`,
      });
      continue;
    }
    matched.add(String(match.id));
    const paperBuySell = p.side === "long" ? "buy" : "sell";
    if (match.side !== paperBuySell) {
      drift.push({
        kind: "side_mismatch",
        paper_position_id: p.id,
        broker_position_id: String(match.id),
        paper_side: p.side,
        broker_side: match.side,
      });
    }
    // E2.24.c: paper `quantity` is BASE UNITS (lots × contractSize —
    // helpers.ts computeSizing), broker `volume` is LOTS. Comparing them
    // raw flagged ~99% "volume_drift" on every mirrored gold position
    // (0.17 lots → quantity 17 vs volume 0.17). Convert paper units → lots
    // before comparing so the gate measures real size divergence.
    const contractSize = getContractSize(p.ticker);
    const paperLots = contractSize > 0 ? p.quantity / contractSize : p.quantity;
    if (match.volume > 0 && paperLots > 0) {
      const driftPct = Math.abs(match.volume - paperLots) / Math.max(match.volume, paperLots);
      if (driftPct > VOLUME_TOLERANCE) {
        drift.push({
          kind: "volume_drift",
          paper_position_id: p.id,
          broker_position_id: String(match.id),
          paper_quantity: p.quantity,
          paper_lots: Number(paperLots.toFixed(4)),
          broker_volume: match.volume,
          drift_pct: Number(driftPct.toFixed(4)),
        });
      }
    }
  }
  for (const b of brokerPositions) {
    if (!matched.has(String(b.id))) {
      drift.push({
        kind: "broker_only",
        broker_position_id: String(b.id),
        symbol: b.symbol,
        side: b.side,
        volume: b.volume,
      });
    }
  }
  return drift;
}

/**
 * E2.24.c.iii — reconcile ALL algos sharing one broker connection in a
 * single pass. Fetching broker positions once per CONNECTION (not once
 * per algo) avoids MetaApi rate-limit spam (5 algos on one connection =
 * 5× redundant fetchPositions), AND fixes a correctness bug: reconciling
 * one algo against the connection's full position set would false-flag
 * sibling algos' positions as `broker_only`. Paper rows across all algos
 * on the connection are matched together.
 */
async function reconcileConnection(
  supabase: SupabaseClient,
  connectionId: string,
  algos: AlgoRow[]
): Promise<Array<{ algorithm_id: string; drift: DriftEntry[] } | { algorithm_id: string; error: string }>> {
  const userId = algos[0].user_id;
  const { data: connData } = await supabase
    .from("broker_connections")
    .select(
      "id, user_id, provider, api_token, account_id, region, status, refresh_token, token_expires_at, account_login, server"
    )
    .eq("id", connectionId)
    .eq("user_id", userId)
    .single();
  if (!connData || connData.status === "disabled") {
    return algos.map((a) => ({ algorithm_id: a.id, error: "broker connection missing or disabled" }));
  }
  const adapter = getBrokerAdapter((connData as { provider: string }).provider);
  if (!adapter) {
    return algos.map((a) => ({ algorithm_id: a.id, error: `no adapter for provider ${(connData as { provider: string }).provider}` }));
  }

  let brokerPositions: BrokerPosition[];
  try {
    brokerPositions = await adapter.fetchPositions(
      brokerConnectionFromRow(connData as Tables<"broker_connections">)
    );
  } catch (err) {
    const msg = adapter.describeError(err);
    return algos.map((a) => ({ algorithm_id: a.id, error: msg }));
  }

  const algoIds = algos.map((a) => a.id);
  const { data: paperData } = await supabase
    .from("paper_positions")
    .select("id, ticker, side, quantity, broker_position_id, algorithm_id")
    .in("algorithm_id", algoIds)
    .eq("status", "open");
  const paper = (paperData ?? []) as Array<PaperPositionRow & { algorithm_id: string }>;

  // Reconcile the whole connection at once (broker_only is correct only
  // when matched against EVERY sibling's paper rows).
  const drift = computeDrift(paper, brokerPositions);

  if (drift.length > 0) {
    logger.error("reconcile", `Connection ${connectionId} drift: ${drift.length} entries across ${algos.length} algos`);
    await logActivity(supabase, userId, {
      algorithm_id: null,
      event_type: "broker_reconciliation_drift",
      details: {
        broker_connection_id: connectionId,
        broker_position_count: brokerPositions.length,
        paper_position_count: paper.length,
        drift,
      },
    });
  }

  // Attribute drift back to algos: paper-side entries by their row's algo,
  // broker_only entries to the connection (algorithm_id null on the event).
  const paperAlgoById = new Map(paper.map((p) => [p.id, p.algorithm_id]));
  const perAlgo = new Map<string, DriftEntry[]>(algoIds.map((id) => [id, []]));
  for (const d of drift) {
    if ("paper_position_id" in d) {
      const aid = paperAlgoById.get(d.paper_position_id);
      if (aid) perAlgo.get(aid)?.push(d);
    }
  }
  return algos.map((a) => ({ algorithm_id: a.id, drift: perAlgo.get(a.id) ?? [] }));
}

export async function GET(request: Request) {
  const authError = verifyAdminAuth(request);
  if (authError) return authError;

  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("algorithms")
    .select("id, user_id, name, broker_connection_id")
    .eq("status", "active")
    .eq("live_trading_enabled", true)
    .not("broker_connection_id", "is", null);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const algos = (data ?? []) as AlgoRow[];
  // E2.24.c.iii: group by broker connection → one fetchPositions per
  // connection instead of per algo (rate-limit + broker_only correctness).
  const byConn = new Map<string, AlgoRow[]>();
  for (const a of algos) {
    const list = byConn.get(a.broker_connection_id) ?? [];
    list.push(a);
    byConn.set(a.broker_connection_id, list);
  }
  const results: Array<{ algorithm_id: string; drift: DriftEntry[] } | { algorithm_id: string; error: string }> = [];
  for (const [connId, connAlgos] of byConn) {
    results.push(...(await reconcileConnection(supabase, connId, connAlgos)));
  }

  const totalDrift = results.reduce(
    (sum, r) => sum + ("drift" in r ? r.drift.length : 0),
    0
  );

  return NextResponse.json({
    algorithms_checked: algos.length,
    connections_checked: byConn.size,
    total_drift_entries: totalDrift,
    results,
  });
}
