/**
 * Unit tests for llm-trader-audit (CB.T1 pass 19, 2026-06-22).
 * Nineteenth test in `src/lib/scan/`. Tests the 3 exports:
 *   - recordLlmDecision (insert row to llm_decisions; null on no-decision
 *     OR insert failure; best-effort — never throws)
 *   - linkLlmDecisionToPosition (update paper_position_id after entry)
 *   - backfillClosedTradeOutcomes (idempotent per-tick backfill of
 *     trade_outcome jsonb on closed positions)
 *
 * Coverage (~22 tests):
 *  recordLlmDecision:
 *   - evaluation.decision null (retry-exhausted) → return null, NO insert
 *   - Insert success → returns row id
 *   - Insert error → returns null + console.error (no throw)
 *   - context merges contextComponents with userMessage
 *   - 13-field insert payload locked (user_id, algorithm_id, bar_date,
 *     prompt_version, provider, model, regime, decision, confidence,
 *     reasoning, context, had_position, source) + paper_position_id +
 *     trade_outcome both initialized to null
 *
 *  linkLlmDecisionToPosition:
 *   - UPDATE sets paper_position_id, WHERE id=decisionId
 *   - Error → console.error (no throw — best-effort audit)
 *
 *  backfillClosedTradeOutcomes:
 *   - Query error → {backfilled: 0} + console.error
 *   - Empty data → {backfilled: 0}, no updates
 *   - paper_positions=null → row skipped
 *   - paper_positions as OBJECT → unwrapped + processed
 *   - paper_positions as ARRAY → first element unwrapped (CB.H3.c typegen quirk)
 *   - initial_stop_loss_price PREFERRED over stop_loss_price for R math
 *     (BE-moved trades use the original 1R anchor, not the moved SL)
 *   - Falls back to stop_loss_price when initial_sl null (legacy rows)
 *   - UPDATE failure on one row → counter not incremented, loop continues
 *   - Multiple rows → backfilled count matches
 *
 *  computeRMultiple (tested via backfill end-to-end):
 *   - Long winner: r = (exit - entry) / (entry - stop) positive
 *   - Long loser: r = negative when exit < entry
 *   - Short winner: mirrored math
 *   - risk ≤ 0 (degenerate stop above entry on long) → r_multiple = 0
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmTraderEvaluation } from "@/lib/scan/llm-trader";
import {
  backfillClosedTradeOutcomes,
  linkLlmDecisionToPosition,
  recordLlmDecision,
} from "./llm-trader-audit";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---- Suppress console.error noise in tests + capture for assertion. ---
const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

// ---- Fixture builders. ------------------------------------------------
function makeEvaluation(opts: {
  decision?: { decision: string; confidence: number; reasoning: string } | null;
  regime?: string;
  userMessage?: string;
} = {}): LlmTraderEvaluation {
  const stub = Object.create(null) as Record<string, unknown>;
  Object.assign(stub, {
    decision: opts.decision === undefined
      ? { decision: "enter_long", confidence: 0.75, reasoning: "FVG + bullish bias" }
      : opts.decision,
    regime: opts.regime ?? "HH",
    userMessage: opts.userMessage ?? "bars: ...",
    promptVersion: "v2",
    provider: "anthropic",
    model: "claude-haiku-4-5",
  });
  return stub as unknown as LlmTraderEvaluation;
}

type PaperRow = {
  side: "long" | "short";
  entry_price: number;
  stop_loss_price: number;
  initial_stop_loss_price: number | null;
  exit_price: number;
  exit_reason: string;
  realized_pnl: number;
  closed_at: string;
  status: string;
};

function makePaperRow(overrides: Partial<PaperRow> = {}): PaperRow {
  return {
    side: "long",
    entry_price: 3000,
    stop_loss_price: 2985,
    initial_stop_loss_price: 2985,
    exit_price: 3045,
    exit_reason: "tp_hit",
    realized_pnl: 150,
    closed_at: "2026-06-22T10:00:00Z",
    status: "closed",
    ...overrides,
  };
}

// ---- Supabase mock for recordLlmDecision (insert-select-single). -----
function makeInsertMock(opts: {
  insertedId?: string | null;
  error?: { message: string } | null;
}): { supabase: SupabaseClient; capturedPayload: () => unknown } {
  let capturedPayload: unknown = null;
  // insertedId === undefined → default "dec-1"; null → explicit null
  // (simulates DB returning no row); string → use as id.
  let resolvedData: { id: string } | null;
  if (opts.insertedId === undefined) {
    resolvedData = { id: "dec-1" };
  } else if (opts.insertedId === null) {
    resolvedData = null;
  } else {
    resolvedData = { id: opts.insertedId };
  }
  const single = vi.fn().mockResolvedValue({
    data: resolvedData,
    error: opts.error ?? null,
  });
  const select = vi.fn().mockReturnValue({ single });
  const insert = vi.fn().mockImplementation((payload: unknown) => {
    capturedPayload = payload;
    return { select };
  });
  const fromMock = vi.fn().mockReturnValue({ insert });
  const stub = Object.create(null) as Record<string, unknown>;
  stub.from = fromMock;
  return {
    supabase: stub as unknown as SupabaseClient,
    capturedPayload: () => capturedPayload,
  };
}

// ---- Supabase mock for linkLlmDecisionToPosition (update-eq). --------
function makeUpdateMock(opts: { error?: { message: string } | null } = {}): {
  supabase: SupabaseClient;
  captures: { payload: Record<string, unknown> | null; eqCalls: Array<[string, unknown]> };
} {
  const captures: {
    payload: Record<string, unknown> | null;
    eqCalls: Array<[string, unknown]>;
  } = { payload: null, eqCalls: [] };
  const fromMock = vi.fn(() => {
    const update = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
      captures.payload = payload;
      const eq = vi.fn().mockImplementation((col: string, val: unknown) => {
        captures.eqCalls.push([col, val]);
        return Promise.resolve({ data: null, error: opts.error ?? null });
      });
      return { eq };
    });
    return { update };
  });
  const stub = Object.create(null) as Record<string, unknown>;
  stub.from = fromMock;
  return { supabase: stub as unknown as SupabaseClient, captures };
}

// ---- Supabase mock for backfillClosedTradeOutcomes. -------------------
// Two phases:
//   1. select.is.not.eq read with joined relation
//   2. update.eq write per qualifying row

type BackfillJoinedRow = {
  id: string;
  paper_position_id: string | null;
  paper_positions: PaperRow | PaperRow[] | null;
};

function makeBackfillMock(opts: {
  selectData?: BackfillJoinedRow[] | null;
  selectError?: { message: string } | null;
  updateErrors?: Map<string, { message: string }>;
}): {
  supabase: SupabaseClient;
  updates: Array<{ id: string; payload: Record<string, unknown> }>;
} {
  const updates: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const fromMock = vi.fn(() => {
    // SELECT path
    const selectResult = {
      data: opts.selectData === undefined ? [] : opts.selectData,
      error: opts.selectError ?? null,
    };
    const selectBuilder = Object.create(null) as Record<string, unknown>;
    selectBuilder.is = vi.fn().mockReturnValue(selectBuilder);
    selectBuilder.not = vi.fn().mockReturnValue(selectBuilder);
    selectBuilder.eq = vi.fn().mockImplementation(() => Promise.resolve(selectResult));
    selectBuilder.then = (
      onfulfilled?: (v: typeof selectResult) => unknown,
      onrejected?: (e: unknown) => unknown
    ) => Promise.resolve(selectResult).then(onfulfilled, onrejected);
    const select = vi.fn().mockReturnValue(selectBuilder);

    // UPDATE path
    const update = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
      const eq = vi.fn().mockImplementation((_col: string, val: unknown) => {
        const id = String(val);
        const err = opts.updateErrors?.get(id);
        updates.push({ id, payload });
        return Promise.resolve({ data: null, error: err ?? null });
      });
      return { eq };
    });

    return { select, update };
  });
  const stub = Object.create(null) as Record<string, unknown>;
  stub.from = fromMock;
  return { supabase: stub as unknown as SupabaseClient, updates };
}

beforeEach(() => {
  vi.clearAllMocks();
  consoleErrorSpy.mockClear();
});

// ======================================================================
// recordLlmDecision
// ======================================================================

describe("recordLlmDecision", () => {
  it("returns null + NO insert when evaluation.decision is null (retry-exhausted)", async () => {
    const { supabase, capturedPayload } = makeInsertMock({});
    const r = await recordLlmDecision(supabase, {
      algorithmId: "algo-1",
      userId: "user-1",
      barDate: "2026-06-22T10:00:00Z",
      evaluation: makeEvaluation({ decision: null }),
      hadPosition: "flat",
      source: "live",
    });
    expect(r).toBeNull();
    expect(capturedPayload()).toBeNull();
  });

  it("insert success → returns row id from response", async () => {
    const { supabase } = makeInsertMock({ insertedId: "dec-XYZ" });
    const r = await recordLlmDecision(supabase, {
      algorithmId: "algo-1",
      userId: "user-1",
      barDate: "2026-06-22T10:00:00Z",
      evaluation: makeEvaluation(),
      hadPosition: "flat",
      source: "live",
    });
    expect(r).toBe("dec-XYZ");
  });

  it("insert error → returns null + console.error (no throw)", async () => {
    const { supabase } = makeInsertMock({
      insertedId: null,
      error: { message: "constraint violation" },
    });
    const r = await recordLlmDecision(supabase, {
      algorithmId: "algo-1",
      userId: "user-1",
      barDate: "2026-06-22T10:00:00Z",
      evaluation: makeEvaluation(),
      hadPosition: "flat",
      source: "live",
    });
    expect(r).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[llm-trader-audit] recordLlmDecision failed:",
      "constraint violation"
    );
  });

  it("context field merges contextComponents with user_message", async () => {
    const { supabase, capturedPayload } = makeInsertMock({});
    await recordLlmDecision(supabase, {
      algorithmId: "algo-1",
      userId: "user-1",
      barDate: "2026-06-22T10:00:00Z",
      evaluation: makeEvaluation({ userMessage: "msg-text" }),
      hadPosition: "flat",
      source: "live",
      contextComponents: { dxy: "rising", regime_age_bars: 12 },
    });
    expect((capturedPayload() as { context: unknown }).context).toEqual({
      user_message: "msg-text",
      dxy: "rising",
      regime_age_bars: 12,
    });
  });

  it("insert payload locks all 14 fields with correct values", async () => {
    const { supabase, capturedPayload } = makeInsertMock({});
    await recordLlmDecision(supabase, {
      algorithmId: "algo-A",
      userId: "user-B",
      barDate: "2026-06-22T10:00:00Z",
      evaluation: makeEvaluation({
        decision: { decision: "enter_short", confidence: 0.82, reasoning: "bearish FVG retest" },
        regime: "LL",
      }),
      hadPosition: "long",
      source: "backtest",
    });
    expect(capturedPayload()).toEqual({
      user_id: "user-B",
      algorithm_id: "algo-A",
      bar_date: "2026-06-22T10:00:00Z",
      prompt_version: "v2",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      regime: "LL",
      decision: "enter_short",
      confidence: 0.82,
      reasoning: "bearish FVG retest",
      context: { user_message: "bars: ..." },
      had_position: "long",
      paper_position_id: null, // always null at insert; linked later
      trade_outcome: null, // always null at insert; backfilled on close
      source: "backtest",
    });
  });
});

// ======================================================================
// linkLlmDecisionToPosition
// ======================================================================

describe("linkLlmDecisionToPosition", () => {
  it("UPDATE sets paper_position_id WHERE id=decisionId", async () => {
    const { supabase, captures } = makeUpdateMock({});
    await linkLlmDecisionToPosition(supabase, "dec-XYZ", "pp-789");
    expect(captures.payload).toEqual({ paper_position_id: "pp-789" });
    expect(captures.eqCalls).toEqual([["id", "dec-XYZ"]]);
  });

  it("update error → console.error (no throw — best-effort audit)", async () => {
    const { supabase } = makeUpdateMock({ error: { message: "row missing" } });
    await expect(
      linkLlmDecisionToPosition(supabase, "dec-1", "pp-1")
    ).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[llm-trader-audit] linkLlmDecisionToPosition failed:",
      "row missing"
    );
  });
});

// ======================================================================
// backfillClosedTradeOutcomes — query + early returns
// ======================================================================

describe("backfillClosedTradeOutcomes — early returns", () => {
  it("query error → {backfilled: 0} + console.error", async () => {
    const { supabase } = makeBackfillMock({
      selectError: { message: "permission denied" },
    });
    const r = await backfillClosedTradeOutcomes(supabase);
    expect(r).toEqual({ backfilled: 0 });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[llm-trader-audit] backfill query failed:",
      "permission denied"
    );
  });

  it("empty data → {backfilled: 0}, no updates", async () => {
    const { supabase, updates } = makeBackfillMock({ selectData: [] });
    const r = await backfillClosedTradeOutcomes(supabase);
    expect(r).toEqual({ backfilled: 0 });
    expect(updates).toEqual([]);
  });
});

// ======================================================================
// backfillClosedTradeOutcomes — relation unwrap (CB.H3.c)
// ======================================================================

describe("backfillClosedTradeOutcomes — relation unwrap", () => {
  it("paper_positions=null → row SKIPPED (no update, counter unchanged)", async () => {
    const { supabase, updates } = makeBackfillMock({
      selectData: [{ id: "dec-1", paper_position_id: "pp-1", paper_positions: null }],
    });
    const r = await backfillClosedTradeOutcomes(supabase);
    expect(updates).toEqual([]);
    expect(r.backfilled).toBe(0);
  });

  it("paper_positions as OBJECT → unwrapped + processed", async () => {
    const { supabase, updates } = makeBackfillMock({
      selectData: [
        {
          id: "dec-1",
          paper_position_id: "pp-1",
          paper_positions: makePaperRow(),
        },
      ],
    });
    const r = await backfillClosedTradeOutcomes(supabase);
    expect(r.backfilled).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe("dec-1");
  });

  it("paper_positions as ARRAY → first element unwrapped (CB.H3.c typegen quirk)", async () => {
    const { supabase, updates } = makeBackfillMock({
      selectData: [
        {
          id: "dec-A",
          paper_position_id: "pp-A",
          paper_positions: [makePaperRow({ entry_price: 4000, exit_price: 4060 })],
        },
      ],
    });
    const r = await backfillClosedTradeOutcomes(supabase);
    expect(r.backfilled).toBe(1);
    // Verify the array-unwrapped row's data flows through to the update
    const outcome = updates[0].payload.trade_outcome as { entry_price: number };
    expect(outcome.entry_price).toBe(4000);
  });

  it("paper_positions as empty ARRAY → row skipped (defensive)", async () => {
    const { supabase, updates } = makeBackfillMock({
      selectData: [
        { id: "dec-1", paper_position_id: "pp-1", paper_positions: [] },
      ],
    });
    const r = await backfillClosedTradeOutcomes(supabase);
    expect(updates).toEqual([]);
    expect(r.backfilled).toBe(0);
  });
});

// ======================================================================
// backfillClosedTradeOutcomes — R-multiple math (via outcome payload)
// ======================================================================

describe("backfillClosedTradeOutcomes — R-multiple math", () => {
  it("Long winner: r = (exit - entry) / (entry - stop) positive", async () => {
    const { supabase, updates } = makeBackfillMock({
      selectData: [
        {
          id: "dec-1",
          paper_position_id: "pp-1",
          paper_positions: makePaperRow({
            side: "long",
            entry_price: 3000,
            stop_loss_price: 2985, // risk = 15
            initial_stop_loss_price: 2985,
            exit_price: 3045, // move = +45 → R = 3.0
          }),
        },
      ],
    });
    await backfillClosedTradeOutcomes(supabase);
    const outcome = updates[0].payload.trade_outcome as { r_multiple: number };
    expect(outcome.r_multiple).toBeCloseTo(3.0, 6);
  });

  it("Long loser: r = negative when exit < entry", async () => {
    const { supabase, updates } = makeBackfillMock({
      selectData: [
        {
          id: "dec-1",
          paper_position_id: "pp-1",
          paper_positions: makePaperRow({
            side: "long",
            entry_price: 3000,
            stop_loss_price: 2985, // risk = 15
            initial_stop_loss_price: 2985,
            exit_price: 2985, // SL hit → R = -1.0
          }),
        },
      ],
    });
    await backfillClosedTradeOutcomes(supabase);
    const outcome = updates[0].payload.trade_outcome as { r_multiple: number };
    expect(outcome.r_multiple).toBeCloseTo(-1.0, 6);
  });

  it("Short winner: mirrored math: r = (entry - exit) / (stop - entry)", async () => {
    const { supabase, updates } = makeBackfillMock({
      selectData: [
        {
          id: "dec-1",
          paper_position_id: "pp-1",
          paper_positions: makePaperRow({
            side: "short",
            entry_price: 3000,
            stop_loss_price: 3015, // risk = 15
            initial_stop_loss_price: 3015,
            exit_price: 2970, // move = -30 → R = 2.0
          }),
        },
      ],
    });
    await backfillClosedTradeOutcomes(supabase);
    const outcome = updates[0].payload.trade_outcome as { r_multiple: number };
    expect(outcome.r_multiple).toBeCloseTo(2.0, 6);
  });

  it("Degenerate risk ≤ 0 (long with stop ABOVE entry) → r_multiple = 0", async () => {
    const { supabase, updates } = makeBackfillMock({
      selectData: [
        {
          id: "dec-1",
          paper_position_id: "pp-1",
          paper_positions: makePaperRow({
            side: "long",
            entry_price: 3000,
            stop_loss_price: 3010, // impossible: stop above entry → risk = -10
            initial_stop_loss_price: 3010,
            exit_price: 3045,
          }),
        },
      ],
    });
    await backfillClosedTradeOutcomes(supabase);
    const outcome = updates[0].payload.trade_outcome as { r_multiple: number };
    expect(outcome.r_multiple).toBe(0);
  });
});

// ======================================================================
// backfillClosedTradeOutcomes — BE-move 1R anchor preservation
// ======================================================================

describe("backfillClosedTradeOutcomes — BE-move 1R anchor", () => {
  it("initial_stop_loss_price PREFERRED over stop_loss_price for R math (BE-moved trades)", async () => {
    // BE move: stop was 2985 (original risk 15), moved to BE 3000 (current risk 0).
    // Without preserving the original 1R, R math would produce divide-by-zero.
    // With initial_stop_loss_price preserved, R = (exit-entry)/(entry-2985) = 3.0
    const { supabase, updates } = makeBackfillMock({
      selectData: [
        {
          id: "dec-1",
          paper_position_id: "pp-1",
          paper_positions: makePaperRow({
            side: "long",
            entry_price: 3000,
            stop_loss_price: 3000, // BE-moved (current SL = entry)
            initial_stop_loss_price: 2985, // original 1R anchor
            exit_price: 3045,
          }),
        },
      ],
    });
    await backfillClosedTradeOutcomes(supabase);
    const outcome = updates[0].payload.trade_outcome as { r_multiple: number };
    expect(outcome.r_multiple).toBeCloseTo(3.0, 6); // uses initial_sl
  });

  it("Falls back to stop_loss_price when initial_sl is null (legacy pre-migration-00032 rows)", async () => {
    const { supabase, updates } = makeBackfillMock({
      selectData: [
        {
          id: "dec-1",
          paper_position_id: "pp-1",
          paper_positions: makePaperRow({
            side: "long",
            entry_price: 3000,
            stop_loss_price: 2985,
            initial_stop_loss_price: null, // legacy row
            exit_price: 3045,
          }),
        },
      ],
    });
    await backfillClosedTradeOutcomes(supabase);
    const outcome = updates[0].payload.trade_outcome as { r_multiple: number };
    expect(outcome.r_multiple).toBeCloseTo(3.0, 6);
  });
});

// ======================================================================
// backfillClosedTradeOutcomes — loop continuation + multi-row
// ======================================================================

describe("backfillClosedTradeOutcomes — multi-row + error continuation", () => {
  it("UPDATE failure on one row → counter NOT incremented, loop CONTINUES to next row", async () => {
    const { supabase } = makeBackfillMock({
      selectData: [
        {
          id: "dec-fail",
          paper_position_id: "pp-1",
          paper_positions: makePaperRow(),
        },
        {
          id: "dec-ok",
          paper_position_id: "pp-2",
          paper_positions: makePaperRow(),
        },
      ],
      updateErrors: new Map([["dec-fail", { message: "row not found" }]]),
    });
    const r = await backfillClosedTradeOutcomes(supabase);
    // Only dec-ok succeeded — counter = 1, not 2
    expect(r.backfilled).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[llm-trader-audit] backfill update failed:",
      "row not found"
    );
  });

  it("Multiple rows successfully processed → backfilled count matches", async () => {
    const { supabase, updates } = makeBackfillMock({
      selectData: [
        { id: "dec-1", paper_position_id: "pp-1", paper_positions: makePaperRow() },
        { id: "dec-2", paper_position_id: "pp-2", paper_positions: makePaperRow() },
        { id: "dec-3", paper_position_id: "pp-3", paper_positions: makePaperRow() },
      ],
    });
    const r = await backfillClosedTradeOutcomes(supabase);
    expect(r.backfilled).toBe(3);
    expect(updates).toHaveLength(3);
    expect(updates.map((u) => u.id).sort()).toEqual(["dec-1", "dec-2", "dec-3"]);
  });

  it("Outcome payload includes all 7 fields (r_multiple, exit_reason, realized_pnl, side, entry/exit price + date)", async () => {
    const { supabase, updates } = makeBackfillMock({
      selectData: [
        {
          id: "dec-1",
          paper_position_id: "pp-1",
          paper_positions: makePaperRow({
            side: "long",
            entry_price: 3000,
            stop_loss_price: 2985,
            initial_stop_loss_price: 2985,
            exit_price: 3045,
            exit_reason: "tp_hit",
            realized_pnl: 150,
            closed_at: "2026-06-22T10:00:00Z",
          }),
        },
      ],
    });
    await backfillClosedTradeOutcomes(supabase);
    expect(updates[0].payload.trade_outcome).toEqual({
      r_multiple: 3.0,
      exit_reason: "tp_hit",
      realized_pnl: 150,
      side: "long",
      entry_price: 3000,
      exit_price: 3045,
      exit_date: "2026-06-22T10:00:00Z",
    });
  });
});
