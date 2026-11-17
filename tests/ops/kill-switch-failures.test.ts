/**
 * The kill switch when things fail, run for real against the fake host in ./fake-host. An emergency run
 * must attempt every step, say what failed and never read OK. The crontab and the service are the two
 * steps that need neither the database nor the app.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  breakLedger,
  breakSave,
  curlCalls,
  failCall,
  ledger,
  makeHost,
  mark,
  runScript,
  savedIds,
} from "./fake-host";

// A test runs real scripts, some several in a row, and the whole suite loads the machine.
vi.setConfig({ testTimeout: 30_000 });

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const short = (id: string): string => id.slice(0, 8);

describe("kill-switch.sh, the database or python failing", () => {
  it("still stops the crons and the service when the database is unreachable", () => {
    const host = makeHost({ active: [A] });
    failCall(host, "list-active");
    failCall(host, "open-count");
    const run = runScript(host, "kill-switch.sh", ["test"]);
    expect(run.status).toBe(1);
    expect(existsSync(join(host.root, "crontab"))).toBe(false);
    expect(ledger(host)).toContain("paused=FAILED");
    expect(ledger(host)).toContain("service=inactive");
    expect(ledger(host)).toContain("open_after=? open_untargeted=?");
  });

  it("reports a failed pause as unknown and has saved the ids, because it may have committed", () => {
    const host = makeHost({ active: [A] });
    failCall(host, "pause");
    runScript(host, "kill-switch.sh", ["test"]);
    expect(ledger(host)).toContain("paused=unknown");
    expect(ledger(host)).toContain("errors=pause");
    expect(savedIds(host)).toEqual([A]);
  });

  it("never reads a broken python as zero open positions", () => {
    const host = makeHost({ active: [A], open: [A] });
    failCall(host, "python");
    const run = runScript(host, "kill-switch.sh", ["test"]);
    expect(run.stdout).toContain("KILL_RESULT=PARTIAL");
    expect(ledger(host)).toContain("open_after=?");
    expect(ledger(host)).toContain("open-after-check");
    expect(ledger(host)).toContain("service=inactive");
  });

  it("works without the database credentials, and says so", () => {
    const host = makeHost({ active: [A], env: "CRON_SECRET=x\nNTFY_TOPIC=fake\n" });
    const run = runScript(host, "kill-switch.sh", ["test"]);
    expect(run.status).toBe(1);
    expect(ledger(host)).toContain("errors=no-supabase-credentials");
    expect(ledger(host)).toContain("service=inactive");
    expect(ledger(host)).toContain("mirroring=n/a");
  });

  it("records an unreadable mirroring state as a question mark", () => {
    const host = makeHost({ active: [A] });
    failCall(host, "mirroring");
    runScript(host, "kill-switch.sh", ["test"]);
    expect(ledger(host)).toContain("mirroring=? ");
  });
});

describe("kill-switch.sh, the app failing", () => {
  it("skips the remaining ids once the app refuses connections", () => {
    const host = makeHost({ active: [A, B] });
    failCall(host, "flatten", "7");
    runScript(host, "kill-switch.sh", ["test"]);
    expect(ledger(host)).toContain(`flatten:${short(A)}:curl7 flatten-skipped:${short(B)}`);
    expect(ledger(host)).toContain("rest skipped");
    expect(ledger(host)).toContain("service=inactive");
  });

  it("tries every id after another curl failure", () => {
    const host = makeHost({ active: [A, B] });
    failCall(host, "flatten", "52");
    runScript(host, "kill-switch.sh", ["test"]);
    expect(ledger(host)).toContain(`flatten:${short(A)}:curl52 flatten:${short(B)}:curl52`);
  });

  it("reports a non-200 answer", () => {
    const host = makeHost({ active: [A] });
    mark(host, "flatten-http", "500");
    runScript(host, "kill-switch.sh", ["test"]);
    expect(ledger(host)).toContain(`errors=flatten:${short(A)}:http500`);
  });

  it("reports a 200 it cannot read", () => {
    const host = makeHost({ active: [A] });
    mark(host, `flatten-${A}.json`, "not json");
    runScript(host, "kill-switch.sh", ["test"]);
    expect(ledger(host)).toContain(`errors=flatten:${short(A)}:unreadable`);
  });

  it("reports a missing CRON_SECRET", () => {
    const env =
      "NEXT_PUBLIC_SUPABASE_URL=https://supabase.test\nSUPABASE_SERVICE_ROLE_KEY=x\nNTFY_TOPIC=fake\n";
    const host = makeHost({ active: [A], env });
    runScript(host, "kill-switch.sh", ["test"]);
    expect(ledger(host)).toContain("flattened=FAILED");
    expect(ledger(host)).toContain("errors=no-cron-secret");
  });
});

describe("kill-switch.sh, the host failing", () => {
  it("reports a crontab it could not remove, and still pauses and stops", () => {
    const host = makeHost({ active: [A] });
    failCall(host, "crontab-r");
    runScript(host, "kill-switch.sh", ["test"]);
    expect(ledger(host)).toContain("crons=FAILED paused=1");
    expect(ledger(host)).toContain("service=inactive");
  });

  it("reports a service it could not stop", () => {
    const host = makeHost({ active: [A] });
    failCall(host, "sudo");
    const run = runScript(host, "kill-switch.sh", ["test"]);
    expect(run.stdout).toContain("KILL_RESULT=PARTIAL");
    expect(ledger(host)).toContain("service=active");
    expect(ledger(host)).toContain("errors=stop-service");
  });

  it("keeps the saved list whole when it cannot be rewritten", () => {
    const host = makeHost({ active: [B], saved: [A], crontab: false });
    breakSave(host, "kill-switch.paused-ids");
    runScript(host, "kill-switch.sh", ["test"]);
    expect(ledger(host)).toContain("save-ids");
    expect(savedIds(host)).toEqual([A]);
  });

  it("reports a flatten list it cannot write", () => {
    const host = makeHost({ active: [A] });
    breakSave(host, "kill-switch.flatten-ids");
    runScript(host, "kill-switch.sh", ["test"]);
    expect(ledger(host)).toContain("errors=save-targets");
  });

  it("reports a push that failed", () => {
    const host = makeHost({ active: [A] });
    failCall(host, "ntfy");
    runScript(host, "kill-switch.sh", ["test"]);
    expect(ledger(host)).toContain("alert=FAILED errors=alert");
  });

  it("a failed ledger append is an error, and a second push says so", () => {
    const host = makeHost({ active: [A] });
    breakLedger(host);
    const run = runScript(host, "kill-switch.sh", ["test"]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("KILL_RESULT=PARTIAL");
    expect(run.stdout).toContain("KILL_ERRORS=ledger");
    expect(curlCalls(host).filter((c) => c.includes("ntfy.sh"))).toHaveLength(2);
  });
});
