/**
 * The kill switch, resume and un-pause on the fake host in ./fake-host, for the cases the first review of the
 * D-35 PR named: the engagement marker that keeps a failed stop from reading as a healthy engine on a second
 * resume, an older crontab copy restored, a lost flatten answer after the route ran, and un-pause keeping the
 * failed-broker list when its ledger line cannot be written.
 */
import { describe, expect, it, vi } from "vitest";
import {
  breakAppend,
  breakLedger,
  breakSave,
  brokerList,
  clearFail,
  CRON_SECRET,
  failCall,
  flattenAnswers,
  hostLog,
  ledger,
  listsLeft,
  makeHost,
  mark,
  runScript,
  savedIds,
  SERVICE_KEY,
  unmark,
  writeLedger,
  writeTicks,
} from "./fake-host";

// A test runs real scripts, some several in a row, and the whole suite loads the machine.
vi.setConfig({ testTimeout: 30_000 });

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("the engagement marker", () => {
  it("keeps a second resume after a failed stop an error, though the first one started the service", () => {
    const host = makeHost({ active: [A, B], crontab: true });
    failCall(host, "crontab-r");
    failCall(host, "list-active");
    writeTicks(host);
    runScript(host, "kill-switch.sh", ["test"]);
    clearFail(host, "list-active");
    runScript(host, "resume.sh");
    const second = runScript(host, "resume.sh");
    expect(second.stdout).toContain("RESUME_RESULT=PARTIAL");
    expect(ledger(host)).toMatch(
      / RESUME .* before=active engaged=1 .*errors=algorithms-active:2\n$/
    );
  });

  it("opens the engagement on its own, and un-pause with nothing to wake records and removes it", () => {
    const host = makeHost({ active: [A], crontab: true, engaged: true });
    writeTicks(host);
    expect(runScript(host, "resume.sh").stdout).toContain("RESUME_ERRORS=algorithms-active:1");
    expect(runScript(host, "unpause.sh").stdout).toContain("UNPAUSE_RESULT=NOTHING");
    expect(ledger(host)).toContain("UNPAUSE result=nothing cleared=kill-switch.engaged ");
    expect(listsLeft(host)).toEqual([]);
  });

  it("is also opened by the flatten list alone", () => {
    const host = makeHost({ active: [A], crontab: true, flattenIds: [B] });
    writeTicks(host);
    const run = runScript(host, "resume.sh");
    expect(run.stdout).toContain("algorithms-active:1");
    expect(run.stdout).toContain("with a kill-switch engagement open");
  });
});

describe("kill-switch.sh, failures on top of failures", () => {
  it("reports both a copy it could not save and a crontab it could not remove", () => {
    const host = makeHost({ active: [A] });
    breakSave(host, "crontab.disabled");
    failCall(host, "crontab-r");
    runScript(host, "kill-switch.sh", ["test"]);
    expect(ledger(host)).toContain("crons=FAILED ");
    expect(ledger(host)).toMatch(/errors=.*save-crontab.*crontab/);
  });

  it("reports a lost answer it could not record", () => {
    const host = makeHost({ active: [A] });
    breakAppend(host, "kill-switch.broker-failed");
    failCall(host, "flatten", "52");
    runScript(host, "kill-switch.sh", ["test"]);
    expect(ledger(host)).toContain("save-broker-failed");
  });

  it("after a lost answer the route acted on, a later run reports it and does not read OK", () => {
    const host = makeHost({ active: [A], open: [A] });
    flattenAnswers(host, A, [{ status: "broker-failed: timeout", broker: "1" }]);
    mark(host, "flatten-lost");
    writeTicks(host);
    runScript(host, "kill-switch.sh", ["first"]);
    expect(brokerList(host)).toBe(`${A} ?\n`);
    runScript(host, "resume.sh");
    // the route closed the paper rows the first time, so a second flatten finds nothing to answer about
    unmark(host, "flatten-lost");
    unmark(host, `flatten-${A}.json`);
    const again = runScript(host, "kill-switch.sh", ["second"]);
    expect(again.stdout).toContain("KILL_ERRORS=broker-unknown-earlier:1\n");
    expect(again.stdout).toContain("KILL_RESULT=PARTIAL");
    expect(ledger(host).trim().split("\n").at(-1)).toContain("open_after=0 ");
  });
});

describe("resume.sh after a copy that could not be saved", () => {
  it("says the crontab it restored is an older copy", () => {
    const host = makeHost({ active: [A], savedCrontab: "*/5 * * * * manage\n" });
    breakSave(host, "crontab.disabled");
    writeTicks(host);
    runScript(host, "kill-switch.sh", ["test"]);
    const run = runScript(host, "resume.sh");
    expect(run.stdout).toContain("RESUME_ERRORS=older-crontab");
    expect(run.stdout).toContain("the copy restored is an older one");
  });
});

describe("unpause.sh when a read or the ledger fails", () => {
  it("records left_paused=? when it cannot read the other targets", () => {
    const host = makeHost({ saved: [B], flattenIds: [A, B], mirroringOn: [false] });
    failCall(host, "still-paused");
    const run = runScript(host, "unpause.sh");
    expect(ledger(host)).toContain("left_paused=? ");
    expect(run.stdout).toContain(
      "could not read whether the engagement's other targets are still paused"
    );
  });

  it("keeps the failed-broker list when its ledger line fails, with or without ids to wake", () => {
    const nothing = makeHost({ flattenIds: [A], brokerFailed: [`${A} 1`] });
    breakLedger(nothing);
    expect(runScript(nothing, "unpause.sh").stdout).toContain("UNPAUSE_RESULT=PARTIAL");
    expect(brokerList(nothing)).toBe(`${A} 1\n`);
    const host = makeHost({ saved: [A], brokerFailed: [`${A} 1`], mirroringOn: [false] });
    breakLedger(host);
    expect(runScript(host, "unpause.sh").stdout).toContain("UNPAUSE_RESULT=PARTIAL");
    expect(brokerList(host)).toBe(`${A} 1\n`);
    expect(savedIds(host)).toEqual([]);
  });

  it("passes the service key on stdin only, its new read included", () => {
    const host = makeHost({ saved: [B], flattenIds: [A, B], mirroringOn: [false] });
    runScript(host, "unpause.sh");
    const argv = hostLog(host, "curl-argv.log");
    expect(argv).not.toContain(SERVICE_KEY);
    expect(argv).not.toContain(CRON_SECRET);
    expect(hostLog(host, "curl-stdin.log")).toContain(SERVICE_KEY);
  });
});

describe("the second review's cases", () => {
  it("says the restored copy is older after a failed save, also when a second run followed", () => {
    const host = makeHost({ active: [A], savedCrontab: "*/5 * * * * manage\n" });
    breakSave(host, "crontab.disabled");
    writeTicks(host);
    runScript(host, "kill-switch.sh", ["first"]);
    runScript(host, "kill-switch.sh", ["second"]);
    expect(runScript(host, "resume.sh").stdout).toContain("RESUME_ERRORS=older-crontab");
  });

  it("counts a broker line with no number as unknown, in the switch and in un-pause", () => {
    const host = makeHost({ active: [A], brokerFailed: [A] });
    expect(runScript(host, "kill-switch.sh", ["test"]).stdout).toContain(
      "broker-unknown-earlier:1"
    );
    const idle = makeHost({ flattenIds: [A], brokerFailed: [A] });
    runScript(idle, "unpause.sh");
    expect(ledger(idle)).toContain("broker_unknown_cleared=1 ");
  });

  it("reads a KILL line after the last UNPAUSE line as an open engagement, and not once un-paused", () => {
    const host = makeHost({ active: [A], crontab: true });
    writeTicks(host);
    writeLedger(host, ["2026-11-13T10:00:00Z KILL reason=test crons=FAILED"]);
    expect(runScript(host, "resume.sh").stdout).toContain("RESUME_ERRORS=algorithms-active:1");
    writeLedger(host, [
      "2026-11-13T10:00:00Z KILL reason=test",
      "2026-11-13T11:00:00Z UNPAUSE algorithms=1",
    ]);
    expect(runScript(host, "resume.sh").stdout).toContain("nothing to resume");
  });

  it("after switch, resume and un-pause, a further resume reads the engine as healthy", () => {
    const host = makeHost({ active: [A], mirroringOn: [false] });
    writeTicks(host);
    runScript(host, "kill-switch.sh", ["test"]);
    runScript(host, "resume.sh");
    runScript(host, "unpause.sh");
    expect(runScript(host, "resume.sh").stdout).toContain("RESUME_RESULT=OK");
  });

  it("says how many of the engagement's targets stay paused when there is nothing to un-pause", () => {
    const host = makeHost({ flattenIds: [A], stillPaused: [A] });
    const run = runScript(host, "unpause.sh");
    expect(ledger(host)).toContain(" left_paused=1 ");
    expect(run.stdout).toContain(`stay paused (${A})`);
  });

  it("reports an engagement marker it could not write", () => {
    const host = makeHost({ active: [A] });
    breakAppend(host, "kill-switch.engaged");
    runScript(host, "kill-switch.sh", ["test"]);
    expect(ledger(host)).toContain("mark-engaged");
  });
});
