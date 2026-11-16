/**
 * Un-pause after a kill switch that could not confirm what it did, on the fake host in ./fake-host: a flatten list the
 * switch could not save leaves left_paused=?, also after a PATCH whose UNPAUSE line ends nothing; and after a switch
 * that could not confirm its pause (its KILL line says paused=FAILED or unknown, or it left none), un-pause ends
 * nothing when no list remains or none of the saved ids was still paused, unless an earlier un-pause's PATCH, whose
 * answer was lost, may have woken them, and after a last run that could not read the active algorithms (paused=FAILED)
 * whatever an earlier run's list says. A switch that finds the marker with no KILL line records
 * earlier-run-unrecorded, and an un-pause that cannot leave kill-switch.woken says so.
 */
import { describe, expect, it, vi } from "vitest";
import {
  breakAppend,
  breakLedger,
  clearFail,
  failCall,
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
const C = "33333333-3333-4333-8333-333333333333";

describe("unpause.sh after a switch that could not save its flatten list", () => {
  it("records left_paused=? although it woke the ids it had", () => {
    const host = makeHost({ saved: [B], flattenIds: [B], mirroringOn: [false] });
    writeLedger(host, [
      "2026-11-13T10:00:00Z KILL reason=test paused=1 errors=save-ids save-targets",
    ]);
    const run = runScript(host, "unpause.sh");
    expect(ledger(host)).toContain(
      " saved mirroring=0/1 broker_failed_cleared=0 broker_unknown_cleared=0 left_paused=? "
    );
    expect(run.stdout).toContain("the kill switch could not save its flatten list");
  });

  it("still reads that KILL line after a PATCH that failed, whose UNPAUSE line ends nothing", () => {
    const host = makeHost({ saved: [B], flattenIds: [B], mirroringOn: [false] });
    writeLedger(host, [
      "2026-11-13T10:00:00Z KILL reason=test paused=1 errors=save-ids save-targets",
      "2026-11-13T11:00:00Z UNPAUSE result=unknown algorithms=? of 1 saved mirroring=0/1",
    ]);
    runScript(host, "unpause.sh");
    expect(ledger(host)).toMatch(
      / UNPAUSE algorithms=1 of 1 saved mirroring=0\/1 .* left_paused=\? /
    );
  });
});

describe("unpause.sh after a switch that could not pause", () => {
  it("ends nothing, so a later resume still reads the active algorithms as the switch's failure", () => {
    const host = makeHost({ active: [A] });
    failCall(host, "list-active");
    runScript(host, "kill-switch.sh", ["test"]);
    clearFail(host, "list-active");
    runScript(host, "resume.sh");
    const run = runScript(host, "unpause.sh");
    expect(run.stdout).toContain("UNPAUSE_RESULT=FAIL");
    expect(run.stdout).toContain("run make kill-switch again, then make resume");
    expect(inState(host, "kill-switch.engaged")).toBe(true);
    const again = runScript(host, "resume.sh");
    expect(again.stdout).toContain("RESUME_ERRORS=algorithms-active:1");
    expect(again.stdout).not.toContain("crontab-off");
  });

  it("offers only the switch when no list remains, since a pause in the app changes no ledger line", () => {
    const host = makeHost({ engaged: true });
    writeLedger(host, ["2026-11-13T10:00:00Z KILL reason=test paused=FAILED errors=list-active"]);
    const run = runScript(host, "unpause.sh");
    expect(run.stdout).toContain("UNPAUSE_RESULT=FAIL");
    expect(run.stdout).not.toContain("pause them in the app");
  });

  it("reads a marker with no KILL line as a switch that could not confirm its pause", () => {
    const host = makeHost({ engaged: true });
    expect(runScript(host, "unpause.sh").stdout).toContain("UNPAUSE_RESULT=FAIL");
    expect(inState(host, "kill-switch.engaged")).toBe(true);
  });

  it("does wake them after a PATCH whose answer was lost, when its UNPAUSE line follows the KILL line", () => {
    const host = makeHost({ saved: [A, B], flattenIds: [A, B], alreadyActive: true });
    writeLedger(host, [
      "2026-11-13T10:00:00Z KILL reason=test paused=unknown errors=pause",
      "2026-11-13T11:00:00Z UNPAUSE result=unknown algorithms=? of 2 saved mirroring=n/a",
    ]);
    expect(runScript(host, "unpause.sh").stdout).toContain("UNPAUSE_RESULT=OK");
    expect(ledger(host)).toContain(" UNPAUSE algorithms=0 of 2 saved ");
  });

  it("ends nothing when none of its saved ids was still paused, as when its PATCH did not commit", () => {
    const host = makeHost({ saved: [A, B], flattenIds: [A, B], alreadyActive: true });
    writeLedger(host, ["2026-11-13T10:00:00Z KILL reason=test paused=unknown errors=pause"]);
    const run = runScript(host, "unpause.sh");
    expect(run.stdout).toContain("UNPAUSE_RESULT=FAIL");
    expect(run.stdout).toContain("none of the 2 saved algorithm(s) was still paused");
    expect(run.stdout).toContain("pause them in the app");
    expect(inState(host, "kill-switch.paused-ids")).toBe(true);
    expect(ledger(host)).not.toContain(" UNPAUSE ");
  });
});

describe("unpause.sh after a last run that could not read the active algorithms", () => {
  it("ends nothing though an earlier run's list remains, so resume still points at the switch", () => {
    const host = makeHost({ active: [A, B], mirroringOn: [false, false] });
    writeTicks(host);
    runScript(host, "kill-switch.sh", ["test"]);
    expect(runScript(host, "resume.sh").stdout).toContain("RESUME_RESULT=OK");
    // an algorithm activated after the resume, then a switch during a database outage
    setActive(host, [C]);
    failCall(host, "list-active");
    runScript(host, "kill-switch.sh", ["test"]);
    clearFail(host, "list-active");
    expect(runScript(host, "resume.sh").stdout).toContain("RESUME_ERRORS=algorithms-active:1");
    const run = runScript(host, "unpause.sh");
    expect(run.stdout).toContain("UNPAUSE_RESULT=FAIL");
    expect(run.stdout).toContain("the saved list is an earlier run's");
    expect(run.stdout).not.toContain("pause them in the app");
    expect(ledger(host)).not.toContain(" UNPAUSE ");
    const again = runScript(host, "resume.sh");
    expect(again.stdout).toContain("RESUME_ERRORS=algorithms-active:1");
    expect(again.stdout).not.toContain("crontab-off");
  });
});

describe("kill-switch.sh after an earlier run that left no KILL line", () => {
  it("records earlier-run-unrecorded, so un-pause cannot say none stays paused", () => {
    const host = makeHost({ engaged: true });
    writeTicks(host);
    runScript(host, "kill-switch.sh", ["test"]);
    expect(ledger(host)).toMatch(/ KILL .*errors=.*earlier-run-unrecorded/);
    expect(runScript(host, "resume.sh").stdout).toContain("RESUME_RESULT=OK");
    expect(runScript(host, "unpause.sh").stdout).toContain("UNPAUSE_RESULT=PARTIAL");
    expect(ledger(host)).toMatch(/ UNPAUSE result=nothing .* left_paused=\? /);
  });

  it("records nothing of the kind when the engagement's KILL line is there", () => {
    const host = makeHost({ engaged: true });
    writeLedger(host, ["2026-11-13T10:00:00Z KILL reason=test paused=0 errors="]);
    runScript(host, "kill-switch.sh", ["test"]);
    expect(ledger(host)).not.toContain("earlier-run-unrecorded");
  });
});

describe("unpause.sh when its ledger line and kill-switch.woken both fail", () => {
  it("says to create that file rather than run the switch", () => {
    const host = makeHost({ saved: [A], flattenIds: [A], mirroringOn: [false] });
    writeLedger(host, ["2026-11-13T10:00:00Z KILL reason=test paused=1 errors="]);
    breakLedger(host);
    breakAppend(host, "kill-switch.woken");
    const run = runScript(host, "unpause.sh");
    expect(run.stdout).toContain("UNPAUSE_RESULT=PARTIAL");
    expect(run.stdout).toContain("could not leave");
    expect(run.stdout).toContain("rather than the switch");
  });
});
