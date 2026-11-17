/**
 * Characterisation — what a daily-loss halt writes when it flattens.
 *
 * `flattenAlgorithmPositions` closes every open paper position with the
 * halt's exit reason and logs `position_closed`. The database CHECK on
 * `paper_positions.exit_reason` (migration 00038) does not accept
 * `daily_loss_halt` or `portfolio_halt`, and flatten never reads the update
 * result, so in production the rows would stay open while the log says
 * "closed" (audit A4; draft PR #291 widens the CHECK). These tests pin the
 * write and keep the silent-failure path visible until #291 lands.
 */
import { describe, expect, it } from "vitest";
import { flattenAlgorithmPositions } from "@/lib/scan/flatten";
import { asFixture } from "@/test-utils/fixture";
import type { SupabaseClient } from "@supabase/supabase-js";

interface Captured {
  updates: { table: string; payload: Record<string, unknown>; filters: unknown[][] }[];
  inserts: { table: string; row: Record<string, unknown> }[];
}

const openPosition = {
  id: "pos-1",
  user_id: "user-1",
  ticker: "XAU/USD",
  entry_price: 4000,
  current_price: 3950,
  realized_pnl: null,
  unrealized_pnl: -420,
  broker_position_id: null,
};

/** Supabase stand-in: algorithms → no broker; paper_positions select → one open row;
 *  update → `updateResult`; activity_log insert → captured. */
function fakeClient(updateResult: { error: { message: string } | null }) {
  const captured: Captured = { updates: [], inserts: [] };
  const from = (table: string) => {
    const filters: unknown[][] = [];
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = (...args: unknown[]) => {
      filters.push(args);
      return chain;
    };
    chain.single = () => Promise.resolve({ data: { broker_connection_id: null }, error: null });
    chain.update = (payload: Record<string, unknown>) => {
      captured.updates.push({ table, payload, filters });
      return chain;
    };
    chain.insert = (row: Record<string, unknown>) => {
      captured.inserts.push({ table, row });
      return Promise.resolve({ error: null });
    };
    chain.then = (resolve: (v: unknown) => void) => {
      resolve(
        captured.updates.some((u) => u.table === table)
          ? updateResult
          : { data: table === "paper_positions" ? [openPosition] : [], error: null }
      );
    };
    return chain;
  };
  return { client: asFixture<SupabaseClient>({ from }), captured };
}

describe("flattenAlgorithmPositions on a paper-only algorithm", () => {
  it("closes at the last known price with the halt's exit reason and logs position_closed", async () => {
    const { client, captured } = fakeClient({ error: null });
    const result = await flattenAlgorithmPositions(client, "algo-1", "daily_loss_halt");

    expect(result).toEqual([{ ticker: "XAU/USD", broker_position_id: null, status: "paper-only" }]);
    const close = captured.updates.find((u) => u.table === "paper_positions");
    expect(close?.payload).toMatchObject({
      status: "closed",
      exit_price: 3950,
      realized_pnl: -420,
      unrealized_pnl: 0,
      exit_reason: "daily_loss_halt",
    });
    expect(close?.filters).toEqual([
      ["id", "pos-1"],
      ["status", "open"],
    ]);
    const log = captured.inserts.find((i) => i.table === "activity_log");
    expect(log?.row).toMatchObject({
      event_type: "position_closed",
      position_id: "pos-1",
      details: { source: "flatten", exit_reason: "daily_loss_halt", flatten_status: "paper-only" },
    });
  });

  it("current behaviour: a rejected close update is not noticed — still 'paper-only', still logged as closed", async () => {
    const { client, captured } = fakeClient({
      error: { message: 'new row violates check constraint "paper_positions_exit_reason_check"' },
    });
    const result = await flattenAlgorithmPositions(client, "algo-1", "daily_loss_halt");
    expect(result[0]?.status).toBe("paper-only");
    expect(captured.inserts.some((i) => i.row.event_type === "position_closed")).toBe(true);
  });

  it.fails(
    "intended: a rejected close is surfaced and never logged as closed (audit A4, draft PR #291)",
    async () => {
      const { client, captured } = fakeClient({
        error: { message: 'new row violates check constraint "paper_positions_exit_reason_check"' },
      });
      const result = await flattenAlgorithmPositions(client, "algo-1", "daily_loss_halt");
      expect(result[0]?.status).not.toBe("paper-only");
      expect(captured.inserts.some((i) => i.row.event_type === "position_closed")).toBe(false);
    }
  );
});
