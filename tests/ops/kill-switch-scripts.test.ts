/**
 * The kill switch, run for real against the fake host in ./fake-host. Pins the fixes for DEBT D-24 (a
 * ledger line on every path that changes state, and a failed append is an error), D-25's script half (a
 * broker position that did not close is an error, and stays one), D-27 (a re-run after make resume
 * flattens what this engagement targeted) and the mirroring state decision 0010 asks for. Every open
 * position is counted, and an emergency run never stops early.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CRON_SECRET,
  curlCalls,
  flattenAnswers,
  hostLog,
  ledger,
  makeHost,
  mark,
  runScript,
  savedIds,
  SERVICE_KEY,
  setActive,
  writeTicks,
} from "./fake-host";

// A test runs real scripts, some several in a row, and the whole suite loads the machine.
vi.setConfig({ testTimeout: 30_000 });

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const short = (id: string): string => id.slice(0, 8);
const flattenCalls = (calls: string[]): string[] => calls.filter((c) => c.includes("flatten-algo"));

describe("kill-switch.sh, a normal engagement", () => {
  it("disables the crons, pauses, flattens, stops, alerts and writes one KILL line", () => {
    const host = makeHost({ active: [A, B], open: [A], mirroringOn: [false, false] });
    const run = runScript(host, "kill-switch.sh", ["test"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("KILL_RESULT=OK");
    expect(ledger(host)).toMatch(
      / KILL reason=test crons=disabled paused=2 flattened=1 service=inactive open_after=0 open_untargeted=0 mirroring=0\/2 alert=sent errors=none\n$/
    );
    expect(existsSync(join(host.root, "crontab"))).toBe(false);
    expect(savedIds(host)).toEqual([A, B]);
  });

  it("removes the crontab before its first database call", () => {
    const host = makeHost({ active: [A] });
    runScript(host, "kill-switch.sh", ["test"]);
    expect(curlCalls(host)[0]).toBe("CRONTAB -r");
  });

  it("reads the mirroring state of the targeted ids", () => {
    const host = makeHost({ active: [A, B] });
    runScript(host, "kill-switch.sh", ["test"]);
    expect(curlCalls(host).join("\n")).toContain(`algorithms?id=in.(${A},${B})`);
  });

  it("passes secrets on stdin, never on the command line", () => {
    const host = makeHost({ active: [A], open: [A] });
    runScript(host, "kill-switch.sh", ["test"]);
    const argv = hostLog(host, "curl-argv.log");
    expect(argv).not.toContain(SERVICE_KEY);
    expect(argv).not.toContain(CRON_SECRET);
    expect(hostLog(host, "curl-stdin.log")).toContain(SERVICE_KEY);
    expect(hostLog(host, "curl-stdin.log")).toContain(CRON_SECRET);
  });

  it("finishes after a dropped ssh session", () => {
    const host = makeHost({ active: [A] });
    mark(host, "send-hup");
    expect(runScript(host, "kill-switch.sh", ["test"]).stdout).toContain("KILL_RESULT=OK");
    expect(ledger(host)).toContain(" KILL reason=test");
  });

  it("is idempotent: a second run skips the flatten and still reports what is open", () => {
    const host = makeHost({ active: [A] });
    runScript(host, "kill-switch.sh", ["first"]);
    const again = runScript(host, "kill-switch.sh", ["second"]);
    expect(again.stdout).toContain("KILL_RESULT=OK");
    expect(ledger(host)).toContain("reason=second crons=already-empty paused=0 flattened=SKIPPED");
    expect(ledger(host).trim().split("\n").at(-1)).toContain("open_after=0 open_untargeted=0");
  });

  it("merges the un-pause list while the crontab is still empty", () => {
    const host = makeHost({ active: [B], saved: [A], crontab: false });
    runScript(host, "kill-switch.sh", ["test"]);
    expect(savedIds(host)).toEqual([A, B]);
  });

  it("keeps a fresh engagement's un-pause list to what it paused, but still flattens the old ids", () => {
    const host = makeHost({ active: [B], saved: [A] });
    runScript(host, "kill-switch.sh", ["fresh"]);
    expect(savedIds(host)).toEqual([B]);
    expect(flattenCalls(curlCalls(host))).toHaveLength(2);
  });
});

describe("kill-switch.sh, a broker position that did not close (D-25)", () => {
  const closes = { status: "broker-closed", broker: "1" };
  const paper = { status: "paper-only", broker: null };

  it("counts the route's broker-failed status as an error even though the route answers 200", () => {
    const host = makeHost({ active: [A] });
    flattenAnswers(host, A, [{ status: "broker-failed: MetaApi 500 timeout", broker: "1" }, paper]);
    const run = runScript(host, "kill-switch.sh", ["test"]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("KILL_RESULT=PARTIAL");
    expect(ledger(host)).toContain("flattened=1 (0 failed, 1 broker-failed)");
    expect(ledger(host)).toContain(`errors=broker-failed:${short(A)}:1`);
  });

  it("counts paper-only on a row with a broker id: the close was never attempted", () => {
    const host = makeHost({ active: [A] });
    flattenAnswers(host, A, [{ status: "paper-only", broker: "1" }]);
    const run = runScript(host, "kill-switch.sh", ["test"]);
    expect(run.stdout).toContain("KILL_RESULT=PARTIAL");
    expect(ledger(host)).toContain(`errors=broker-failed:${short(A)}:1`);
  });

  it("counts broker-closed, and paper-only with no broker id, as flattened", () => {
    const host = makeHost({ active: [A] });
    flattenAnswers(host, A, [closes, paper]);
    const run = runScript(host, "kill-switch.sh", ["test"]);
    expect(run.stdout).toContain("KILL_RESULT=OK");
    expect(ledger(host)).toContain("flattened=2 ");
  });

  it("stays an error on a re-run, when the paper row is already closed", () => {
    const host = makeHost({ active: [A] });
    flattenAnswers(host, A, [{ status: "broker-failed: timeout", broker: "1" }]);
    runScript(host, "kill-switch.sh", ["first"]);
    const again = runScript(host, "kill-switch.sh", ["second"]);
    expect(again.stdout).toContain("KILL_RESULT=PARTIAL");
    expect(again.stdout).toContain("broker-failed-earlier:1");
  });

  it("reads statuses the real route writes", () => {
    const source = readFileSync(resolve(process.cwd(), "src/lib/scan/flatten.ts"), "utf8");
    expect(source).toContain("`broker-failed: ${");
    expect(source).toContain('let status = "paper-only"');
    expect(source).toContain('status = "broker-closed"');
  });
});

describe("kill-switch.sh, a re-run after make resume (D-27)", () => {
  it("flattens the saved ids although the crontab is back and nothing is active", () => {
    const host = makeHost({ active: [], saved: [A, B], crontab: true, open: [A] });
    const run = runScript(host, "kill-switch.sh", ["rerun"]);
    expect(run.stdout).toContain("KILL_RESULT=OK");
    expect(flattenCalls(curlCalls(host))).toHaveLength(2);
    expect(ledger(host)).toContain("crons=disabled paused=0 flattened=1 ");
    expect(ledger(host)).toContain("open_after=0 ");
    expect(savedIds(host)).toEqual([A, B]);
  });

  it("does not lose an id across switch, resume, re-activate, switch, resume, switch", () => {
    const host = makeHost({ active: [A, B], open: [A] });
    mark(host, `keep-open-${A}`);
    writeTicks(host);
    runScript(host, "kill-switch.sh", ["one"]);
    runScript(host, "resume.sh");
    setActive(host, [B]);
    runScript(host, "kill-switch.sh", ["two"]);
    expect(savedIds(host)).toEqual([B]);
    runScript(host, "resume.sh");
    const third = runScript(host, "kill-switch.sh", ["three"]);
    expect(third.stdout).toContain("KILL_ERRORS=open-after:1");
    expect(flattenCalls(curlCalls(host)).filter((c) => c.includes(A)).length).toBe(3);
  });
});

describe("kill-switch.sh, positions it did not target", () => {
  it("reports one on a paused algorithm although other algorithms were targeted", () => {
    const host = makeHost({ active: [A], open: [C] });
    const run = runScript(host, "kill-switch.sh", ["test"]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("KILL_RESULT=PARTIAL");
    expect(ledger(host)).toContain("open_after=0 open_untargeted=1");
    expect(ledger(host)).toContain("errors=open-untargeted:1");
    expect(flattenCalls(curlCalls(host)).join()).not.toContain(C);
  });

  it("reports them when there is no id to flatten at all", () => {
    const host = makeHost({ active: [], open: [C] });
    const run = runScript(host, "kill-switch.sh", ["test"]);
    expect(run.status).toBe(1);
    expect(ledger(host)).toContain("flattened=SKIPPED");
    expect(ledger(host)).toContain("errors=open-untargeted:1");
  });

  it("reports a targeted position the flatten did not close", () => {
    const host = makeHost({ active: [A], open: [A] });
    mark(host, `keep-open-${A}`);
    runScript(host, "kill-switch.sh", ["test"]);
    expect(ledger(host)).toContain("open_after=1 open_untargeted=0");
    expect(ledger(host)).toContain("errors=open-after:1");
  });
});
