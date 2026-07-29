/** Unit tests for the static session-window gate (2026-10 spec §7). */
import { describe, expect, it } from "vitest";
import { checkSessionFilter } from "./session-filter-gate";

const LONDON = { start_hour_utc: 6, end_hour_utc: 10 };

describe("checkSessionFilter", () => {
  it("inside the window → pass", () => {
    const r = checkSessionFilter({ config: LONDON, barDate: "2026-07-29T08:00:00Z" });
    expect(r.block).toBe(false);
    expect(r.status).toBe("ok");
    expect(r.hour_utc).toBe(8);
  });

  it("outside the window → block with reason", () => {
    const r = checkSessionFilter({ config: LONDON, barDate: "2026-07-29T14:00:00Z" });
    expect(r.block).toBe(true);
    expect(r.status).toBe("outside_window");
    expect(r.reason).toContain("06:00–10:00 UTC");
  });

  it("boundaries: start inclusive, end exclusive", () => {
    expect(checkSessionFilter({ config: LONDON, barDate: "2026-07-29T06:00:00Z" }).block).toBe(false);
    expect(checkSessionFilter({ config: LONDON, barDate: "2026-07-29T10:00:00Z" }).block).toBe(true);
  });

  it("wrap-around window (22→04) spans midnight", () => {
    const overnight = { start_hour_utc: 22, end_hour_utc: 4 };
    expect(checkSessionFilter({ config: overnight, barDate: "2026-07-29T23:00:00Z" }).block).toBe(false);
    expect(checkSessionFilter({ config: overnight, barDate: "2026-07-30T02:00:00Z" }).block).toBe(false);
    expect(checkSessionFilter({ config: overnight, barDate: "2026-07-29T12:00:00Z" }).block).toBe(true);
  });

  it("absent config / degenerate window / missing or bad date → pass-through", () => {
    expect(checkSessionFilter({ config: null, barDate: "2026-07-29T08:00:00Z" }).status).toBe("disabled");
    expect(
      checkSessionFilter({ config: { start_hour_utc: 5, end_hour_utc: 5 }, barDate: "2026-07-29T08:00:00Z" }).block
    ).toBe(false);
    expect(checkSessionFilter({ config: LONDON, barDate: null }).block).toBe(false);
    expect(checkSessionFilter({ config: LONDON, barDate: "not-a-date" }).block).toBe(false);
  });
});
