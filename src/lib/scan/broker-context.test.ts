/**
 * CB.T1 Tier 3 — broker-context.ts (2026-06-23).
 *
 * Tests the resolveBrokerContext dispatch + 4 short-circuit paths:
 *   - liveEnabled=false → null (no DB query)
 *   - algoBrokerId=null → null (no DB query)
 *   - broker_connections row not found / status='disabled' → null
 *   - provider has no adapter → null + logger.warn
 *   - happy path → { adapter, conn }
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBrokerAdapter } from "@/lib/brokers/registry";
import { logger } from "@/lib/logger";
import { resolveBrokerContext } from "./broker-context";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/brokers/registry", () => ({ getBrokerAdapter: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const mockedAdapter = vi.mocked(getBrokerAdapter);
const mockedLogger = vi.mocked(logger);

function makeSupabaseMock(opts: { data?: unknown; error?: { message: string } | null } = {}) {
  const fromMock = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: opts.data ?? null,
            error: opts.error ?? null,
          }),
        }),
      }),
    }),
  });
  const stub = Object.create(null) as Record<string, unknown>;
  stub.from = fromMock;
  return { supabase: stub as unknown as SupabaseClient, fromMock };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedAdapter.mockReturnValue({ fetchQuote: vi.fn() } as unknown as ReturnType<typeof getBrokerAdapter>);
});

describe("resolveBrokerContext — short-circuit paths", () => {
  it("liveEnabled=false → null + NO DB query", async () => {
    const { supabase, fromMock } = makeSupabaseMock();
    const r = await resolveBrokerContext(supabase, "user-1", "broker-id", false);
    expect(r).toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("algoBrokerId=null → null + NO DB query", async () => {
    const { supabase, fromMock } = makeSupabaseMock();
    const r = await resolveBrokerContext(supabase, "user-1", null, true);
    expect(r).toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("broker row not found (data=null) → null", async () => {
    const { supabase } = makeSupabaseMock({ data: null });
    const r = await resolveBrokerContext(supabase, "user-1", "broker-id", true);
    expect(r).toBeNull();
  });

  it("broker row status='disabled' → null", async () => {
    const { supabase } = makeSupabaseMock({
      data: { id: "b1", user_id: "u1", provider: "metaapi", status: "disabled" },
    });
    const r = await resolveBrokerContext(supabase, "user-1", "broker-id", true);
    expect(r).toBeNull();
  });

  it("provider has no adapter → null + logger.warn (alerts on silent fallback)", async () => {
    mockedAdapter.mockReturnValue(null);
    const { supabase } = makeSupabaseMock({
      data: { id: "b1", user_id: "u1", provider: "unknownprovider", status: "active" },
    });
    const r = await resolveBrokerContext(supabase, "user-1", "broker-id", true);
    expect(r).toBeNull();
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      "live-execution",
      expect.stringContaining("no adapter for provider=\"unknownprovider\"")
    );
  });

  it("happy path → { adapter, conn }", async () => {
    const fakeAdapter = { fetchQuote: vi.fn() } as unknown as ReturnType<typeof getBrokerAdapter>;
    mockedAdapter.mockReturnValue(fakeAdapter);
    const conn = { id: "b1", user_id: "u1", provider: "metaapi", status: "active" };
    const { supabase } = makeSupabaseMock({ data: conn });
    const r = await resolveBrokerContext(supabase, "user-1", "broker-id", true);
    expect(r).toEqual({ adapter: fakeAdapter, conn });
  });
});
