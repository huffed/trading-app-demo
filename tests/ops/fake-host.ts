/**
 * Runs the real scripts/ops kill-switch scripts on a throwaway fake host: their absolute paths are
 * rewritten into a temporary directory and tests/ops/fixtures/fake-host puts stand-ins for curl,
 * crontab, systemctl, sudo, python3 and id first on PATH. Each script is fed to `bash -s` on stdin, as
 * the make targets stream it over ssh, so a command that read the script's stdin would show here. The
 * fake flatten route closes open rows, as the real one does, so a test sees what is left. Nothing here
 * reaches the VPS, Supabase or ntfy.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface FakeHost {
  root: string;
  state: string;
  logs: string;
}

export interface HostSeed {
  active?: string[];
  /** One open position per entry, on that algorithm. */
  open?: string[];
  saved?: string[];
  crontab?: boolean;
  service?: "active" | "inactive";
  mirroringOn?: boolean[];
  env?: string;
  /** The un-pause PATCH finds nothing still paused: an earlier PATCH committed. */
  alreadyActive?: boolean;
  /** The engagement's flatten list, kill-switch.flatten-ids. */
  flattenIds?: string[];
  /** Lines of the failed-broker list: "<id> <positions>", or "<id> ?" for a lost flatten answer. */
  brokerFailed?: string[];
  /** Which ids the un-pause finds still paused among the engagement's other targets. */
  stillPaused?: string[];
  /** An earlier saved crontab, kept from an older engagement. */
  savedCrontab?: string;
  /** The kill switch's engagement marker, kill-switch.engaged. */
  engaged?: boolean;
}

export interface RunResult {
  status: number | null;
  stdout: string;
  /** The pid of the bash that ran the script, which a signal test checks was the one signalled. */
  pid: number;
}

export const SERVICE_KEY = "service-key-value";
export const CRON_SECRET = "cron-secret-value";
export const FULL_ENV = `NEXT_PUBLIC_SUPABASE_URL=https://supabase.test\nSUPABASE_SERVICE_ROLE_KEY=${SERVICE_KEY}\nCRON_SECRET=${CRON_SECRET}\nNTFY_TOPIC=fake\n`;

const FAKES = resolve(process.cwd(), "tests/ops/fixtures/fake-host");
const CRONTAB = "*/5 * * * * manage\n*/15 * * * * scan\n";

const rows = (ids: string[]): string => JSON.stringify(ids.map((id) => ({ id })));
const LISTS = [
  "kill-switch.engaged",
  "kill-switch.paused-ids",
  "kill-switch.flatten-ids",
  "kill-switch.broker-failed",
];

function seedDatabase(root: string, seed: HostSeed): void {
  writeFileSync(join(root, "active.json"), rows(seed.active ?? []));
  const open = (seed.open ?? []).map((id, i) => ({ id: `p${String(i)}`, algorithm_id: id }));
  writeFileSync(join(root, "open.json"), JSON.stringify(open));
  const mirroring = (seed.mirroringOn ?? []).map((on) => ({ id: "x", live_trading_enabled: on }));
  writeFileSync(join(root, "mirroring.json"), JSON.stringify(mirroring));
  const changed = mirroring.length > 0 ? mirroring : [{ id: "x" }];
  writeFileSync(join(root, "unpause.json"), JSON.stringify(seed.alreadyActive ? [] : changed));
  writeFileSync(join(root, "still-paused.json"), rows(seed.stillPaused ?? []));
}

function seedState(state: string, seed: HostSeed): void {
  const lists: [string, string[] | undefined][] = [
    ["kill-switch.paused-ids", seed.saved],
    ["kill-switch.flatten-ids", seed.flattenIds],
    ["kill-switch.broker-failed", seed.brokerFailed],
  ];
  for (const [name, list] of lists) {
    if (list) writeFileSync(join(state, name), `${list.join("\n")}\n`);
  }
  if (seed.savedCrontab !== undefined) {
    writeFileSync(join(state, "crontab.disabled"), seed.savedCrontab);
  }
  if (seed.engaged) writeFileSync(join(state, "kill-switch.engaged"), "");
}

export function makeHost(seed: HostSeed = {}): FakeHost {
  const root = mkdtempSync(join(tmpdir(), "qt-fake-host-"));
  const host = { root, state: join(root, "state"), logs: join(root, "log") };
  for (const dir of [host.state, host.logs, join(root, "app")]) {
    mkdirSync(dir);
  }
  seedDatabase(root, seed);
  writeFileSync(join(root, "app", ".env.local"), seed.env ?? FULL_ENV);
  writeFileSync(join(root, "service"), `${seed.service ?? "active"}\n`);
  if (seed.crontab ?? true) {
    writeFileSync(join(root, "crontab"), CRONTAB);
  }
  seedState(host.state, seed);
  return host;
}

/** Writes the flatten route's body for one algorithm, in the shape src/lib/scan/flatten.ts returns. */
export function flattenAnswers(
  host: FakeHost,
  id: string,
  answers: { status: string; broker: string | null }[]
): void {
  const results = answers.map(({ status, broker }) => ({
    ticker: "XAU/USD",
    broker_position_id: broker,
    status,
  }));
  writeFileSync(
    join(host.root, `flatten-${id}.json`),
    JSON.stringify({ flattened: results.length, results })
  );
}

/** Makes one fake call fail: an exit code, or 22 as `curl -f` does. Also fail-sudo, fail-python and the like. */
export function failCall(host: FakeHost, name: string, code = ""): void {
  writeFileSync(join(host.root, `fail-${name}`), code);
}

/** Removes a marker file that mark wrote. */
export function unmark(host: FakeHost, name: string): void {
  rmSync(join(host.root, name), { force: true });
}

/** Writes ledger lines, as earlier runs left them. */
export function writeLedger(host: FakeHost, lines: string[]): void {
  writeFileSync(join(host.logs, "deploys.log"), `${lines.join("\n")}\n`);
}

/** Lets a call that failCall broke work again, as when the database comes back. */
export function clearFail(host: FakeHost, name: string): void {
  rmSync(join(host.root, `fail-${name}`), { force: true });
}

/** Touches a marker file the stand-ins read: flatten-http, flatten-lost, keep-open-<id>, send-signal, flatten-<id>.json. */
export function mark(host: FakeHost, name: string, content = ""): void {
  writeFileSync(join(host.root, name), content);
}

export function setActive(host: FakeHost, ids: string[]): void {
  writeFileSync(join(host.root, "active.json"), rows(ids));
}

/** Makes the ledger unwritable: `>>` onto a directory fails. */
export function breakLedger(host: FakeHost): void {
  mkdirSync(join(host.logs, "deploys.log"));
}

/** Makes a saved list unwritable, as a full disk does. */
export function breakSave(host: FakeHost, list: string): void {
  mkdirSync(join(host.state, `${list}.new`));
}

/** Makes a list that is appended to unwritable: `>>` onto a directory fails. */
export function breakAppend(host: FakeHost, list: string): void {
  mkdirSync(join(host.state, list));
}

/** The crontab the kill switch saved, for resume to restore. */
export function saveCrontab(host: FakeHost): void {
  writeFileSync(join(host.state, "crontab.disabled"), CRONTAB);
}

/** Gives resume's tick verification three ticks newer than any run. */
export function writeTicks(host: FakeHost): void {
  for (const name of ["manage", "heartbeat", "scan"]) {
    writeFileSync(join(host.logs, `${name}.log`), "[2099-01-01T00:00:00Z] http=200 body={}\n");
  }
}

export function runScript(host: FakeHost, script: string, args: string[] = []): RunResult {
  const source = readFileSync(resolve(process.cwd(), "scripts/ops", script), "utf8")
    .replaceAll("/opt/quanttrader", join(host.root, "app"))
    .replaceAll("/var/log/quanttrader", host.logs)
    .replaceAll("/var/lib/quanttrader", host.state);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FAKE_HOST: host.root,
    PATH: `${FAKES}:${process.env.PATH ?? ""}`,
  };
  // as `git show … | ssh qt 'bash -s'` runs it: the script is bash's stdin
  const run = spawnSync("bash", ["-s", "--", ...args], { encoding: "utf8", env, input: source });
  return { status: run.status, stdout: run.stdout, pid: run.pid };
}

export const savedCrontab = (host: FakeHost): string => {
  const path = join(host.state, "crontab.disabled");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};

export const brokerList = (host: FakeHost): string => {
  const path = join(host.state, "kill-switch.broker-failed");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};

const readLog = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

export const ledger = (host: FakeHost): string => readLog(join(host.logs, "deploys.log"));
export const hostLog = (host: FakeHost, name: string): string => readLog(join(host.root, name));
export const curlCalls = (host: FakeHost): string[] => hostLog(host, "curl.log").trim().split("\n");

export const savedIds = (host: FakeHost): string[] => {
  const path = join(host.state, "kill-switch.paused-ids");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
};

export const listsLeft = (host: FakeHost): string[] =>
  LISTS.filter((name) => existsSync(join(host.state, name)));
