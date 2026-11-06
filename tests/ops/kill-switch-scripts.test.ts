/**
 * The kill switch, its resume and the un-pause, run for real against the fake host in ./fake-host.
 * Pins the fixes for DEBT D-24 (a ledger line on every path that changes state, and a failed append
 * is an error), D-25 (a failed broker close is an error), D-27 (a re-run after make resume flattens
 * what an earlier run saved) and the mirroring state decision 0010 asks all three to print.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  breakLedger,
  curlCalls,
  failCall,
  flattenAnswers,
  ledger,
  makeHost,
  runScript,
  saveCrontab,
  savedIds,
  writeTicks,
} from "./fake-host";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const flattenCalls = (calls: string[]): string[] => calls.filter((c) => c.includes("flatten-algo"));

describe("kill-switch.sh, a normal engagement", () => {
  it("disables the crons, pauses, flattens, stops, alerts and writes one KILL line", () => {
    const host = makeHost({ active: [A, B], mirroringOn: [false, false] });
    const run = runScript(host, "kill-switch.sh", ["test"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("KILL_RESULT=OK");
    expect(ledger(host)).toMatch(
      / KILL reason=test crons=disabled paused=2 flattened=0 service=inactive open_after=0 mirroring=0\/2 alert=sent errors=none\n$/
    );
    expect(existsSync(join(host.root, "crontab"))).toBe(false);
    expect(savedIds(host)).toEqual([A, B]);
  });

  it("is idempotent: a second run skips the flatten and still counts what is open", () => {
    const host = makeHost({ active: [A] });
    runScript(host, "kill-switch.sh", ["first"]);
    const again = runScript(host, "kill-switch.sh", ["second"]);
    expect(again.stdout).toContain("KILL_RESULT=OK");
    expect(ledger(host)).toContain("reason=second crons=already-empty paused=0 flattened=SKIPPED");
  });

  it("keeps a fresh engagement's un-pause list to what it paused, but still flattens the old ids", () => {
    const host = makeHost({ active: [B], saved: [A] });
    runScript(host, "kill-switch.sh", ["fresh"]);
    expect(savedIds(host)).toEqual([B]);
    expect(flattenCalls(curlCalls(host))).toHaveLength(2);
  });
});

describe("kill-switch.sh, a failed broker close (D-25)", () => {
  it("counts the route's broker-failed status as an error even though the route answers 200", () => {
    const host = makeHost({ active: [A] });
    flattenAnswers(host, A, ["broker-failed: MetaApi 500 timeout", "paper-only"]);
    const run = runScript(host, "kill-switch.sh", ["test"]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("KILL_RESULT=PARTIAL");
    expect(ledger(host)).toContain("flattened=1 (0 failed, 1 broker-failed)");
    expect(ledger(host)).toContain(`errors=broker-failed:${A.slice(0, 8)}:1`);
  });

  it("counts broker-closed and paper-only as flattened", () => {
    const host = makeHost({ active: [A] });
    flattenAnswers(host, A, ["broker-closed", "paper-only"]);
    const run = runScript(host, "kill-switch.sh", ["test"]);
    expect(run.stdout).toContain("KILL_RESULT=OK");
    expect(ledger(host)).toContain("flattened=2 ");
  });
});

describe("kill-switch.sh, a re-run after make resume (D-27)", () => {
  it("flattens the saved ids although the crontab is back and nothing is active", () => {
    const host = makeHost({ active: [], saved: [A, B], crontab: true });
    flattenAnswers(host, A, ["paper-only"]);
    const run = runScript(host, "kill-switch.sh", ["rerun"]);
    expect(run.stdout).toContain("KILL_RESULT=OK");
    expect(flattenCalls(curlCalls(host))).toHaveLength(2);
    expect(ledger(host)).toContain("crons=disabled paused=0 flattened=1 ");
    expect(savedIds(host)).toEqual([A, B]);
  });

  it("makes open positions with no id to flatten an error, not a silent OK", () => {
    const host = makeHost({ active: [], open: 1 });
    const run = runScript(host, "kill-switch.sh", ["test"]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("KILL_RESULT=PARTIAL");
    expect(ledger(host)).toContain("flattened=SKIPPED");
    expect(ledger(host)).toContain("open_after=1");
    expect(ledger(host)).toContain("errors=open-untargeted:1");
  });

  it("still fails closed when the database is unreachable", () => {
    const host = makeHost({ active: [A] });
    failCall(host, "list-active");
    failCall(host, "open-count");
    const run = runScript(host, "kill-switch.sh", ["test"]);
    expect(run.status).toBe(1);
    expect(existsSync(join(host.root, "crontab"))).toBe(false);
    expect(ledger(host)).toContain("paused=FAILED");
    expect(ledger(host)).toContain("service=inactive");
    expect(ledger(host)).toContain("open_after=?");
  });
});

describe("a failed append to the ledger is an error (D-24)", () => {
  it("in the kill switch", () => {
    const host = makeHost({ active: [A] });
    breakLedger(host);
    const run = runScript(host, "kill-switch.sh", ["test"]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("KILL_RESULT=PARTIAL");
    expect(run.stdout).toContain("KILL_ERRORS=ledger");
  });

  it("in resume", () => {
    const host = makeHost({ crontab: true });
    writeTicks(host);
    breakLedger(host);
    const run = runScript(host, "resume.sh");
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("RESUME_RESULT=PARTIAL");
  });

  it("in unpause, after the algorithms are active and the id list is gone", () => {
    const host = makeHost({ saved: [A], mirroringOn: [false] });
    breakLedger(host);
    const run = runScript(host, "unpause.sh");
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("UNPAUSE_RESULT=PARTIAL");
    expect(savedIds(host)).toEqual([]);
  });
});

describe("resume.sh", () => {
  it("restores the crontab, leaves the algorithms paused and records the saved ids' mirroring state", () => {
    const host = makeHost({ crontab: false, saved: [A, B], mirroringOn: [true, false] });
    saveCrontab(host);
    writeTicks(host);
    const run = runScript(host, "resume.sh");
    expect(run.stdout).toContain("RESUME_RESULT=OK");
    expect(ledger(host)).toMatch(
      / RESUME service=active crons=2 active_algorithms=0 mirroring=1\/2 alert=sent errors=none\n$/
    );
    expect(savedIds(host)).toEqual([A, B]);
  });

  it(
    "D-28: reports an error while algorithms are active and the crontab is installed",
    { fails: true },
    () => {
      const host = makeHost({ active: [A], crontab: true });
      writeTicks(host);
      expect(runScript(host, "resume.sh").stdout).toContain("RESUME_RESULT=PARTIAL");
    }
  );
});

describe("unpause.sh", () => {
  it("re-activates the saved ids, records the mirroring state and removes the list", () => {
    const host = makeHost({ saved: [A, B], mirroringOn: [false, true] });
    const run = runScript(host, "unpause.sh");
    expect(run.stdout).toContain("UNPAUSE_RESULT=OK");
    expect(ledger(host)).toMatch(/ UNPAUSE algorithms=2 of 2 saved mirroring=1\/2\n$/);
    expect(savedIds(host)).toEqual([]);
  });

  it("writes result=unknown and keeps the list when the PATCH fails, because it may have committed", () => {
    const host = makeHost({ saved: [A] });
    failCall(host, "unpause");
    const run = runScript(host, "unpause.sh");
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("UNPAUSE_RESULT=FAIL");
    expect(ledger(host)).toMatch(/ UNPAUSE result=unknown algorithms=\? of 1 saved\n$/);
    expect(savedIds(host)).toEqual([A]);
  });

  it("refuses while the service is stopped and writes nothing", () => {
    const host = makeHost({ saved: [A], service: "inactive" });
    const run = runScript(host, "unpause.sh");
    expect(run.status).toBe(1);
    expect(ledger(host)).toBe("");
  });
});
