/**
 * Un-pause and resume keep their records straight, on the fake host in ./fake-host: un-pause keeps the engagement
 * marker and the failed-broker list when its ledger line cannot be written, so the next un-pause ends the
 * engagement in the ledger, and takes the ids it saved off the flatten list, so a later switch does not flatten them
 * but still flattens the other targets; its retry ends the engagement, while a later switch that could not pause
 * keeps it open; resume reads a KILL line before a result=unknown one as an engagement open; crontab.unsaved goes
 * once a copy is saved again or the engagement ends; a restored copy that matches ops/crontab is not called older; a
 * switch that could not save its list leaves left_paused=?, and one that found nothing to pause leaves 0; an
 * engagement only the ledger records ends; the crontab hint when the crontab stays on; a failed service; and resume
 * on an engine already running with the crontab off.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  breakAppend,
  breakLedger,
  breakSave,
  brokerList,
  clearFail,
  curlCalls,
  failCall,
  fixLedger,
  fixSave,
  inState,
  ledger,
  makeHost,
  runScript,
  setActive,
  writeLedger,
  writeTicks,
} from "./fake-host";

// A test runs real scripts, some several in a row, and the whole suite loads the machine.
vi.setConfig({ testTimeout: 30_000 });

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const CRONTAB = "*/5 * * * * manage\n*/15 * * * * scan\n";

describe("unpause.sh when its ledger line fails", () => {
  it("keeps the marker and the broker list, and the next run ends the engagement in the ledger", () => {
    const host = makeHost({
      saved: [A],
      engaged: true,
      brokerFailed: [`${A} 1`],
      mirroringOn: [false],
    });
    writeTicks(host);
    breakLedger(host);
    expect(runScript(host, "unpause.sh").stdout).toContain("UNPAUSE_RESULT=PARTIAL");
    expect(inState(host, "kill-switch.engaged")).toBe(true);
    expect(brokerList(host)).toBe(`${A} 1\n`);
    fixLedger(host);
    writeLedger(host, ["2026-11-13T10:00:00Z KILL reason=test"]);
    runScript(host, "unpause.sh");
    expect(ledger(host)).toContain(
      " cleared=kill-switch.engaged,kill-switch.broker-failed,ledger-kill left_paused=0 "
    );
    expect(runScript(host, "resume.sh").stdout).toContain("nothing to resume");
  });

  it("takes the ids it saved off the flatten list, and the next run counts the targets still paused", () => {
    const host = makeHost({
      saved: [A],
      flattenIds: [A, B],
      stillPaused: [B],
      mirroringOn: [false],
    });
    breakLedger(host);
    const first = runScript(host, "unpause.sh");
    expect(first.stdout).toContain("run make unpause again once the ledger can be written");
    expect(inState(host, "kill-switch.paused-ids")).toBe(false);
    expect(inState(host, "kill-switch.flatten-ids")).toBe(true);
    fixLedger(host);
    const second = runScript(host, "unpause.sh");
    expect(ledger(host)).toContain(" cleared=kill-switch.flatten-ids left_paused=1 ");
    expect(second.stdout).toContain("UNPAUSE_RESULT=PARTIAL");
  });
});

describe("after an un-pause whose ledger line failed", () => {
  it("its retry ends the engagement, even after a switch whose PATCH committed unconfirmed", () => {
    const host = makeHost({ active: [A], mirroringOn: [false] });
    writeTicks(host);
    failCall(host, "pause");
    runScript(host, "kill-switch.sh", ["test"]);
    clearFail(host, "pause");
    // the PATCH had committed: nothing is active any more
    setActive(host, []);
    expect(runScript(host, "resume.sh").stdout).toContain("RESUME_RESULT=OK");
    breakLedger(host);
    expect(runScript(host, "unpause.sh").stdout).toContain("UNPAUSE_RESULT=PARTIAL");
    fixLedger(host);
    const retry = runScript(host, "unpause.sh");
    expect(retry.stdout).toContain("UNPAUSE_RESULT=NOTHING");
    expect(ledger(host)).toContain(" UNPAUSE result=nothing ");
    expect(inState(host, "kill-switch.engaged")).toBe(false);
    expect(inState(host, "kill-switch.woken")).toBe(false);
  });

  it("a later kill switch flattens none of the algorithms it woke", () => {
    const host = makeHost({
      saved: [A, B],
      flattenIds: [A, B],
      mirroringOn: [false, false],
      open: [B],
    });
    breakLedger(host);
    runScript(host, "unpause.sh");
    fixLedger(host);
    // the operator then pauses B on purpose, keeping its open position
    setActive(host, [A]);
    runScript(host, "kill-switch.sh", ["test"]);
    expect(curlCalls(host).filter((c) => c.includes("flatten-algo"))).toEqual([
      `POST http://127.0.0.1:3000/api/admin/flatten-algo?id=${A}`,
    ]);
  });

  it("the targets still paused stay on the flatten list, so a later switch flattens them again", () => {
    const host = makeHost({
      saved: [A],
      flattenIds: [A, B],
      stillPaused: [B],
      mirroringOn: [false],
      open: [B],
    });
    breakLedger(host);
    runScript(host, "unpause.sh");
    fixLedger(host);
    setActive(host, [A]);
    runScript(host, "kill-switch.sh", ["test"]);
    const flattened = curlCalls(host).filter((c) => c.includes("flatten-algo"));
    expect(flattened).toContain(`POST http://127.0.0.1:3000/api/admin/flatten-algo?id=${B}`);
  });

  it("does not let a later switch that could not pause be ended by un-pause", () => {
    const host = makeHost({
      active: [A],
      saved: [A],
      flattenIds: [A],
      engaged: true,
      mirroringOn: [false],
    });
    breakLedger(host);
    runScript(host, "unpause.sh");
    fixLedger(host);
    failCall(host, "list-active");
    runScript(host, "kill-switch.sh", ["test"]);
    clearFail(host, "list-active");
    expect(runScript(host, "resume.sh").stdout).toContain("RESUME_ERRORS=algorithms-active:1");
    expect(runScript(host, "unpause.sh").stdout).toContain("UNPAUSE_RESULT=FAIL");
    const again = runScript(host, "resume.sh");
    expect(again.stdout).toContain("RESUME_ERRORS=algorithms-active:1");
    expect(again.stdout).not.toContain("crontab-off");
  });
});

describe("the engagement marker on its own", () => {
  it("opens the engagement when the ledger's last line is an UNPAUSE", () => {
    const host = makeHost({ active: [A], crontab: true, engaged: true });
    writeTicks(host);
    writeLedger(host, [
      "2026-11-13T10:00:00Z KILL reason=test",
      "2026-11-13T11:00:00Z UNPAUSE algorithms=1",
    ]);
    expect(runScript(host, "resume.sh").stdout).toContain("RESUME_ERRORS=algorithms-active:1");
  });
});

describe("crontab.unsaved", () => {
  it("goes once a later run saves its copy", () => {
    const host = makeHost({ active: [A], savedCrontab: "old\n" });
    breakSave(host, "crontab.disabled");
    writeTicks(host);
    runScript(host, "kill-switch.sh", ["first"]);
    expect(inState(host, "crontab.unsaved")).toBe(true);
    runScript(host, "resume.sh");
    fixSave(host, "crontab.disabled");
    runScript(host, "kill-switch.sh", ["second"]);
    expect(inState(host, "crontab.unsaved")).toBe(false);
  });

  it("goes when un-pause ends the engagement", () => {
    const host = makeHost({ saved: [A], unsaved: true, mirroringOn: [false] });
    runScript(host, "unpause.sh");
    expect(inState(host, "crontab.unsaved")).toBe(false);
  });

  it("is not reported when the copy restored matches ops/crontab", () => {
    const host = makeHost({ active: [A], savedCrontab: CRONTAB, opsCrontab: CRONTAB });
    breakSave(host, "crontab.disabled");
    writeTicks(host);
    runScript(host, "kill-switch.sh", ["test"]);
    expect(runScript(host, "resume.sh").stdout).toContain("RESUME_RESULT=OK");
  });
});

describe("unpause.sh after a switch that saved no list", () => {
  it("records left_paused=? and says to check the algorithms page", () => {
    const host = makeHost({ engaged: true });
    writeLedger(host, [
      "2026-11-13T10:00:00Z KILL reason=test paused=1 errors=save-ids save-targets",
    ]);
    const run = runScript(host, "unpause.sh");
    expect(ledger(host)).toContain(" left_paused=? ");
    expect(run.stdout).toContain("no list of what the kill switch paused remains");
  });

  it("records left_paused=0 after a switch that found nothing to pause", () => {
    const host = makeHost({ engaged: true });
    writeLedger(host, ["2026-11-13T10:00:00Z KILL reason=test paused=0 errors=none"]);
    const run = runScript(host, "unpause.sh");
    expect(ledger(host)).toContain(" left_paused=0 ");
    expect(run.stdout).not.toContain("no list of what the kill switch paused remains");
  });
});

describe("an engagement only the ledger records", () => {
  it("is ended by un-pause, so a later resume reads the engine as healthy", () => {
    const host = makeHost({ active: [A] });
    writeTicks(host);
    writeLedger(host, [
      "2026-11-13T10:00:00Z KILL reason=test paused=1 errors=mark-engaged save-ids save-targets",
    ]);
    const run = runScript(host, "unpause.sh");
    expect(run.stdout).toContain("UNPAUSE_RESULT=PARTIAL");
    expect(run.stdout).toContain("no list of what the kill switch paused remains");
    expect(ledger(host)).toContain(" cleared=ledger-kill left_paused=? ");
    expect(runScript(host, "resume.sh").stdout).toContain("nothing to resume");
  });
});

describe("kill-switch.sh when the crontab stays on", () => {
  it("says the crons are still on, not what resume would restore", () => {
    const host = makeHost({ active: [A], savedCrontab: "old\n" });
    breakSave(host, "crontab.disabled");
    failCall(host, "crontab-r");
    const run = runScript(host, "kill-switch.sh", ["test"]);
    expect(run.stdout).toContain(
      "crontab disable FAILED, so the crons are still on: run make kill-switch again; its copy NOT saved either"
    );
    expect(run.stdout).not.toContain("OLDER copy");
  });

  it("reports a crontab.unsaved marker it could not write", () => {
    const host = makeHost({ active: [A] });
    breakSave(host, "crontab.disabled");
    breakAppend(host, "crontab.unsaved");
    runScript(host, "kill-switch.sh", ["test"]);
    expect(ledger(host)).toContain("mark-unsaved");
  });
});

describe("resume.sh on the service's other states", () => {
  it("reads a failed service as not running, so active algorithms with the crontab on are an error", () => {
    const host = makeHost({ active: [A], service: "failed" });
    writeTicks(host);
    expect(runScript(host, "resume.sh").stdout).toContain("RESUME_ERRORS=algorithms-active:1");
    expect(ledger(host)).toMatch(/ RESUME .* before=failed engaged=0\n/);
  });

  it("tells an engine already running with the crontab off to install it, not to run the switch", () => {
    const host = makeHost({ active: [A], crontab: false, savedCrontab: CRONTAB });
    const run = runScript(host, "resume.sh");
    expect(run.stdout).toContain("RESUME_ERRORS=crontab-off");
    expect(run.stdout).toContain("do not run make kill-switch");
    expect(run.stdout).not.toContain("run make kill-switch again");
  });

  it("reads a list an un-pause set aside, or a KILL line before a result=unknown one, as an engagement open", () => {
    const kept = makeHost({ active: [A] });
    writeFileSync(join(kept.state, "kill-switch.flatten-ids.kept"), `${A}\n`);
    expect(runScript(kept, "resume.sh").stdout).toContain("RESUME_ERRORS=algorithms-active:1");
    const host = makeHost({ active: [A] });
    writeLedger(host, [
      "2026-11-13T10:00:00Z KILL reason=test paused=1 errors=none",
      "2026-11-13T11:00:00Z UNPAUSE result=unknown algorithms=? of 1 saved mirroring=0/1",
    ]);
    expect(runScript(host, "resume.sh").stdout).toContain("RESUME_ERRORS=algorithms-active:1");
  });

  it("reads an engagement still open with the crontab off as a switch that did not pause", () => {
    const host = makeHost({ active: [A], crontab: false, engaged: true, savedCrontab: CRONTAB });
    const run = runScript(host, "resume.sh");
    expect(run.stdout).toContain("RESUME_ERRORS=algorithms-active:1");
    expect(run.stdout).not.toContain("crontab-off");
  });
});
