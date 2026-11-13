/**
 * The kill switch, resume and un-pause on the fake host in ./fake-host: what DEBT D-35 found missing. The
 * crontab goes even when its copy cannot be saved; a flatten whose answer was lost stays on the broker
 * list; earlier broker failures count positions; untargeted positions name their algorithms; un-pause
 * says what stays paused and what broker failures it clears; resume reads a running engine with no
 * engagement open as healthy; and each script carries on through HUP, INT and PIPE.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  breakAppend,
  breakSave,
  brokerList,
  curlCalls,
  failCall,
  type FakeHost,
  flattenAnswers,
  hostLog,
  ledger,
  listsLeft,
  makeHost,
  mark,
  runScript,
  saveCrontab,
  savedCrontab,
  writeTicks,
} from "./fake-host";

// A test runs real scripts, some several in a row, and the whole suite loads the machine.
vi.setConfig({ testTimeout: 30_000 });

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const CRONTAB = "*/5 * * * * manage\n*/15 * * * * scan\n";
const crontabGone = (root: string): boolean => !existsSync(join(root, "crontab"));

describe("kill-switch.sh, the crontab when its copy cannot be saved", () => {
  it("removes the crontab anyway, keeps the older copy and says resume would restore it", () => {
    const host = makeHost({ active: [A], savedCrontab: "old\n" });
    breakSave(host, "crontab.disabled");
    const run = runScript(host, "kill-switch.sh", ["test"]);
    expect(crontabGone(host.root)).toBe(true);
    expect(savedCrontab(host)).toBe("old\n");
    expect(ledger(host)).toContain("crons=disabled-unsaved ");
    expect(ledger(host)).toContain("save-crontab");
    expect(run.stdout).toContain("make resume would restore an OLDER copy");
  });

  it("with no older copy, says to install ops/crontab before resuming", () => {
    const host = makeHost({ active: [A] });
    breakSave(host, "crontab.disabled");
    const run = runScript(host, "kill-switch.sh", ["test"]);
    expect(crontabGone(host.root)).toBe(true);
    expect(run.stdout).toContain("install ops/crontab from the repo");
  });

  it("replaces an older copy whole when the save works", () => {
    const host = makeHost({ active: [A], savedCrontab: "old\n" });
    runScript(host, "kill-switch.sh", ["test"]);
    expect(savedCrontab(host)).toBe(CRONTAB);
    expect(ledger(host)).toContain("crons=disabled ");
  });
});

describe("kill-switch.sh, a flatten whose answer was lost", () => {
  it("records the id as unknown after a timeout, and skips the rest", () => {
    const host = makeHost({ active: [A, B] });
    failCall(host, "flatten", "28");
    runScript(host, "kill-switch.sh", ["test"]);
    expect(brokerList(host)).toBe(`${A} ?\n`);
    expect(ledger(host)).toContain(`flatten-skipped:${B.slice(0, 8)}`);
  });

  it("records every id after a dropped reply", () => {
    const host = makeHost({ active: [A, B] });
    failCall(host, "flatten", "52");
    runScript(host, "kill-switch.sh", ["test"]);
    expect(brokerList(host)).toBe(`${A} ?\n${B} ?\n`);
  });

  it("records a 5xx and an unreadable 200, not a 4xx or a refused connection", () => {
    const cases: [(h: FakeHost) => void, string][] = [
      [
        (h) => {
          mark(h, "flatten-http", "500");
        },
        `${A} ?\n`,
      ],
      [
        (h) => {
          mark(h, `flatten-${A}.json`, "not json");
        },
        `${A} ?\n`,
      ],
      [
        (h) => {
          mark(h, "flatten-http", "401");
        },
        "",
      ],
      [
        (h) => {
          failCall(h, "flatten", "7");
        },
        "",
      ],
    ];
    for (const [arrange, expected] of cases) {
      const host = makeHost({ active: [A] });
      arrange(host);
      runScript(host, "kill-switch.sh", ["test"]);
      expect(brokerList(host)).toBe(expected);
    }
  });

  it("reminds the next run, which cannot retry it", () => {
    const host = makeHost({ active: [A] });
    failCall(host, "flatten", "52");
    runScript(host, "kill-switch.sh", ["first"]);
    expect(runScript(host, "kill-switch.sh", ["second"]).stdout).toContain(
      "broker-unknown-earlier:1"
    );
  });

  it("reports a broker list it cannot append to", () => {
    const host = makeHost({ active: [A] });
    breakAppend(host, "kill-switch.broker-failed");
    flattenAnswers(host, A, [{ status: "broker-failed: timeout", broker: "1" }]);
    runScript(host, "kill-switch.sh", ["test"]);
    expect(ledger(host)).toContain("save-broker-failed");
  });
});

describe("kill-switch.sh, earlier broker failures and untargeted positions", () => {
  it("counts earlier broker failures in positions, and lost answers apart", () => {
    const host = makeHost({ active: [A], brokerFailed: [`${A} 2`, `${B} 1`, `${C} ?`] });
    const run = runScript(host, "kill-switch.sh", ["test"]);
    expect(run.stdout).toContain("broker-failed-earlier:3");
    expect(run.stdout).toContain("broker-unknown-earlier:1");
    expect(run.stdout).toContain(`(${A} ${B} ${C})`);
  });

  it("names the algorithms of the positions it did not target", () => {
    const host = makeHost({ active: [A], open: [C, B] });
    const run = runScript(host, "kill-switch.sh", ["test"]);
    expect(run.stdout).toContain(`did not target (${B} ${C})`);
    expect(ledger(host)).toContain("open_untargeted=2");
  });
});

describe("resume.sh on an engine that is already running", () => {
  it("reads a running service with its crontab and no engagement open as healthy", () => {
    const host = makeHost({ active: [A], crontab: true });
    writeTicks(host);
    const run = runScript(host, "resume.sh");
    expect(run.stdout).toContain("RESUME_RESULT=OK");
    expect(run.stdout).toContain("nothing to resume");
    expect(ledger(host)).toContain("active_algorithms=1 ");
    expect(ledger(host)).toContain("errors=none");
    expect(hostLog(host, "curl-argv.log")).toContain("Priority: default");
  });

  it("still reports active algorithms while an engagement is open", () => {
    const host = makeHost({ active: [A], crontab: true, saved: [B] });
    writeTicks(host);
    const run = runScript(host, "resume.sh");
    expect(run.stdout).toContain("RESUME_ERRORS=algorithms-active:1");
    expect(run.stdout).toContain("with a kill-switch engagement open");
  });

  it("reads the saved ids' mirroring state with their id list", () => {
    const host = makeHost({ crontab: false, saved: [A, B] });
    saveCrontab(host);
    writeTicks(host);
    runScript(host, "resume.sh");
    expect(curlCalls(host).join("\n")).toContain(
      `algorithms?id=in.(${A},${B})&select=live_trading_enabled`
    );
  });
});

describe("unpause.sh, what stays paused and what it clears", () => {
  it("counts the engagement's other targets that stay paused, and names them", () => {
    const host = makeHost({
      saved: [B],
      flattenIds: [A, B],
      stillPaused: [A],
      mirroringOn: [false],
    });
    const run = runScript(host, "unpause.sh");
    expect(run.stdout).toContain("UNPAUSE_RESULT=OK");
    expect(ledger(host)).toContain("algorithms=1 of 1 saved left_paused=1 ");
    expect(run.stdout).toContain(`stay paused (${A})`);
    expect(curlCalls(host).join("\n")).toContain(
      `algorithms?id=in.(${A})&status=eq.paused&select=id`
    );
  });

  it("says what the broker list held before it goes", () => {
    const host = makeHost({ saved: [A], brokerFailed: [`${A} 1`, `${B} ?`], mirroringOn: [false] });
    const run = runScript(host, "unpause.sh");
    expect(ledger(host)).toContain("broker_failed_cleared=1 broker_unknown_cleared=1 ");
    expect(run.stdout).toContain("check the broker account");
    expect(listsLeft(host)).toEqual([]);
  });

  it("clears the broker list a kill switch left, and records what it held", () => {
    const host = makeHost({ active: [A], mirroringOn: [false] });
    flattenAnswers(host, A, [{ status: "broker-failed: timeout", broker: "1" }]);
    writeTicks(host);
    runScript(host, "kill-switch.sh", ["test"]);
    runScript(host, "resume.sh");
    runScript(host, "unpause.sh");
    expect(ledger(host)).toContain("broker_failed_cleared=1 ");
    expect(listsLeft(host)).toEqual([]);
  });

  it("sends the saved id list in its PATCH and its mirroring read", () => {
    const host = makeHost({ saved: [A, B], mirroringOn: [false, false] });
    runScript(host, "unpause.sh");
    const calls = curlCalls(host).join("\n");
    expect(calls).toContain(`algorithms?status=eq.paused&id=in.(${A},${B})&select=id`);
    expect(calls).toContain(`algorithms?id=in.(${A},${B})&select=live_trading_enabled`);
  });
});

describe("unpause.sh with nothing to un-pause", () => {
  it("ends the engagement, says what the broker list held and records what it cleared", () => {
    const host = makeHost({ flattenIds: [A], brokerFailed: [`${A} 1`] });
    const run = runScript(host, "unpause.sh");
    expect(run.stdout).toContain("UNPAUSE_RESULT=NOTHING");
    expect(run.stdout).toContain("check the broker account");
    expect(listsLeft(host)).toEqual([]);
    expect(ledger(host)).toMatch(
      / UNPAUSE result=nothing cleared=kill-switch.flatten-ids,kill-switch.broker-failed broker_failed_cleared=1 broker_unknown_cleared=0\n$/
    );
  });

  it("writes nothing when no list is left", () => {
    const host = makeHost({});
    expect(runScript(host, "unpause.sh").stdout).toContain("UNPAUSE_RESULT=NOTHING");
    expect(ledger(host)).toBe("");
  });
});

describe("each script carries on through a dropped session's signals", () => {
  it.each(["HUP", "INT", "PIPE"])("kill-switch.sh finishes after SIG%s", (signal) => {
    const host = makeHost({ active: [A] });
    mark(host, "send-signal", signal);
    expect(runScript(host, "kill-switch.sh", ["test"]).stdout).toContain("KILL_RESULT=OK");
    expect(ledger(host)).toContain(" KILL reason=test");
  });

  it.each(["HUP", "INT", "PIPE"])("resume.sh finishes after SIG%s", (signal) => {
    const host = makeHost({ crontab: true });
    writeTicks(host);
    mark(host, "send-signal", signal);
    expect(runScript(host, "resume.sh").stdout).toContain("RESUME_RESULT=OK");
  });

  it.each(["HUP", "INT", "PIPE"])("unpause.sh finishes after SIG%s", (signal) => {
    const host = makeHost({ saved: [A], mirroringOn: [false] });
    mark(host, "send-signal", signal);
    expect(runScript(host, "unpause.sh").stdout).toContain("UNPAUSE_RESULT=OK");
  });
});
