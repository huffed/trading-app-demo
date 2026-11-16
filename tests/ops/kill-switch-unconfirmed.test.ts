/**
 * Un-pause after a kill switch that could not confirm what it did, on the fake host in ./fake-host: a flatten list the
 * switch could not save leaves left_paused=?, also after a PATCH whose UNPAUSE line ends nothing; and after a switch
 * that could not confirm its pause (its KILL line says paused=FAILED or unknown, or it left none), un-pause ends
 * nothing when no list remains or none of the saved ids was still paused, unless an earlier un-pause's PATCH, whose
 * answer was lost, may have woken them.
 */
import { describe, expect, it, vi } from "vitest";
import {
  clearFail,
  failCall,
  inState,
  ledger,
  makeHost,
  runScript,
  writeLedger,
} from "./fake-host";

// A test runs real scripts, some several in a row, and the whole suite loads the machine.
vi.setConfig({ testTimeout: 30_000 });

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

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
