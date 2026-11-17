/**
 * make resume and make unpause, run for real against the fake host in ./fake-host. Resume brings the
 * service and the crons back and leaves the algorithms paused; un-pause is the operator's act and ends
 * the engagement. Pins D-24 (the ledger) and the mirroring state decision 0010 asks for.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  breakLedger,
  curlCalls,
  failCall,
  hostLog,
  ledger,
  listsLeft,
  makeHost,
  mark,
  runScript,
  saveCrontab,
  savedIds,
  writeTicks,
} from "./fake-host";

// A test runs real scripts, some several in a row, and the whole suite loads the machine.
vi.setConfig({ testTimeout: 30_000 });

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

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
    expect(curlCalls(host).filter((c) => c.startsWith("PATCH"))).toEqual([]);
  });

  it("keeps the crontab off while an algorithm is active", () => {
    const host = makeHost({ active: [A], crontab: false });
    saveCrontab(host);
    const run = runScript(host, "resume.sh");
    expect(run.stdout).toContain("RESUME_RESULT=PARTIAL");
    expect(ledger(host)).toContain("errors=algorithms-active:1");
    expect(existsSync(join(host.root, "crontab"))).toBe(false);
  });

  it("keeps the crontab off when it cannot read the check: a broken python is not zero", () => {
    const host = makeHost({ crontab: false });
    saveCrontab(host);
    failCall(host, "python");
    const run = runScript(host, "resume.sh");
    expect(run.stdout).toContain("RESUME_RESULT=PARTIAL");
    expect(ledger(host)).toContain("active_algorithms=?");
    expect(ledger(host)).toContain("algorithms-check-failed");
    expect(existsSync(join(host.root, "crontab"))).toBe(false);
  });

  it("finishes after a dropped ssh session", () => {
    const host = makeHost({ crontab: true });
    writeTicks(host);
    mark(host, "send-hup");
    expect(runScript(host, "resume.sh").stdout).toContain("RESUME_RESULT=OK");
  });

  it("a failed ledger append is an error, and a second push says so", () => {
    const host = makeHost({ crontab: true });
    writeTicks(host);
    breakLedger(host);
    const run = runScript(host, "resume.sh");
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("RESUME_RESULT=PARTIAL");
    expect(curlCalls(host).filter((c) => c.includes("ntfy.sh"))).toHaveLength(2);
  });
});

describe("resume.sh with the crontab already installed (D-28)", () => {
  it("reports an error while algorithms are active and the crontab is installed (D-28)", () => {
    const host = makeHost({ active: [A], crontab: true });
    writeTicks(host);
    const run = runScript(host, "resume.sh");
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("RESUME_RESULT=PARTIAL");
    expect(run.stdout).toContain("algorithms-active:1");
    expect(ledger(host)).toContain("errors=algorithms-active:1");
    const push = hostLog(host, "curl-argv.log");
    expect(push).toContain("Priority: high");
    expect(push).toContain("1 ACTIVE, not paused");
    expect(push).not.toContain("still paused");
  });

  it("stops nothing and does not wait for ticks when it finds them active (D-28)", () => {
    const host = makeHost({ active: [A], crontab: true });
    writeTicks(host);
    const run = runScript(host, "resume.sh");
    expect(run.stdout).toContain("tick verification skipped");
    expect(existsSync(join(host.root, "crontab"))).toBe(true);
    expect(curlCalls(host).filter((c) => c.startsWith("PATCH"))).toEqual([]);
  });

  it("with no database credentials and the crontab installed, reports that and no active count", () => {
    const host = makeHost({ active: [A], crontab: true, env: "NTFY_TOPIC=t\n" });
    writeTicks(host);
    const run = runScript(host, "resume.sh");
    expect(run.stdout).toContain("RESUME_ERRORS=no-supabase-credentials");
    expect(run.stdout).not.toContain("algorithms-active");
  });

  it("a failed check with the crontab installed reports the failure, not an active count", () => {
    const host = makeHost({ active: [A], crontab: true });
    writeTicks(host);
    failCall(host, "list-active");
    const run = runScript(host, "resume.sh");
    expect(run.stdout).toContain("RESUME_ERRORS=algorithms-check-failed");
    expect(run.stdout).not.toContain("algorithms-active");
    expect(run.stdout).toContain("any active algorithm trades as soon as the database answers");
    expect(hostLog(host, "curl-argv.log")).toContain("not checked: algorithms may be active");
  });
});

describe("unpause.sh", () => {
  it("re-activates the saved ids, records the mirroring state and ends the engagement", () => {
    const host = makeHost({ saved: [A, B], mirroringOn: [false, true] });
    const run = runScript(host, "unpause.sh");
    expect(run.stdout).toContain("UNPAUSE_RESULT=OK");
    expect(ledger(host)).toMatch(/ UNPAUSE algorithms=2 of 2 saved mirroring=1\/2\n$/);
    expect(listsLeft(host)).toEqual([]);
  });

  it("clears the flatten and broker lists a kill switch left", () => {
    const host = makeHost({ active: [A], mirroringOn: [false] });
    writeTicks(host);
    runScript(host, "kill-switch.sh", ["test"]);
    expect(listsLeft(host)).toContain("kill-switch.flatten-ids");
    runScript(host, "resume.sh");
    runScript(host, "unpause.sh");
    expect(listsLeft(host)).toEqual([]);
  });

  it("records the mirroring state of the saved ids when the rows were already active", () => {
    const host = makeHost({ saved: [A], mirroringOn: [true], alreadyActive: true });
    runScript(host, "unpause.sh");
    expect(ledger(host)).toMatch(/ UNPAUSE algorithms=0 of 1 saved mirroring=1\/1\n$/);
  });

  it("writes result=unknown and keeps the list when the PATCH fails, because it may have committed", () => {
    const host = makeHost({ saved: [A], mirroringOn: [false] });
    failCall(host, "unpause");
    const run = runScript(host, "unpause.sh");
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("UNPAUSE_RESULT=FAIL");
    expect(ledger(host)).toMatch(
      / UNPAUSE result=unknown algorithms=\? of 1 saved mirroring=0\/1\n$/
    );
    expect(savedIds(host)).toEqual([A]);
  });

  it("a failed ledger append is an error, after the algorithms are active and the list is gone", () => {
    const host = makeHost({ saved: [A], mirroringOn: [false] });
    breakLedger(host);
    const run = runScript(host, "unpause.sh");
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("UNPAUSE_RESULT=PARTIAL");
    expect(savedIds(host)).toEqual([]);
  });

  it("refuses while the service is stopped and writes nothing", () => {
    const host = makeHost({ saved: [A], service: "inactive" });
    const run = runScript(host, "unpause.sh");
    expect(run.status).toBe(1);
    expect(ledger(host)).toBe("");
  });

  it("ignores a dropped ssh session, as the other two do", () => {
    const source = readFileSync(resolve(process.cwd(), "scripts/ops/unpause.sh"), "utf8");
    expect(source).toContain("trap '' HUP INT PIPE");
  });
});
