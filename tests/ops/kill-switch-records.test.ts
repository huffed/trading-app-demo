/**
 * Un-pause and resume keep their records straight, on the fake host in ./fake-host: un-pause keeps the engagement
 * marker and the failed-broker list when its ledger line cannot be written, so the next un-pause ends the
 * engagement in the ledger; crontab.unsaved goes once a copy is saved again or the engagement ends; a restored
 * copy that matches ops/crontab is not called older; and a switch that saved no list leaves left_paused=?.
 */
import { describe, expect, it, vi } from "vitest";
import {
  breakLedger,
  breakSave,
  brokerList,
  fixLedger,
  fixSave,
  inState,
  ledger,
  makeHost,
  runScript,
  writeLedger,
  writeTicks,
} from "./fake-host";

// A test runs real scripts, some several in a row, and the whole suite loads the machine.
vi.setConfig({ testTimeout: 30_000 });

const A = "11111111-1111-4111-8111-111111111111";
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
      "UNPAUSE result=nothing cleared=kill-switch.engaged,kill-switch.broker-failed "
    );
    expect(runScript(host, "resume.sh").stdout).toContain("nothing to resume");
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
    const run = runScript(host, "unpause.sh");
    expect(ledger(host)).toContain(" left_paused=? ");
    expect(run.stdout).toContain("the kill switch saved no list of what it paused");
  });
});
