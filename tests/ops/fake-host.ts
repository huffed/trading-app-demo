/**
 * Runs the real scripts/ops kill-switch scripts on a throwaway fake host: their absolute paths are
 * rewritten into a temporary directory and tests/ops/fixtures/fake-host puts stand-ins for curl,
 * crontab, systemctl, sudo, python3 and id first on PATH. The fake flatten route closes open rows, as
 * the real one does, so a test sees what is left. Nothing here reaches the VPS, Supabase or ntfy.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
}

export interface RunResult {
  status: number | null;
  stdout: string;
}

export const SERVICE_KEY = "service-key-value";
export const CRON_SECRET = "cron-secret-value";
export const FULL_ENV = `NEXT_PUBLIC_SUPABASE_URL=https://supabase.test\nSUPABASE_SERVICE_ROLE_KEY=${SERVICE_KEY}\nCRON_SECRET=${CRON_SECRET}\nNTFY_TOPIC=fake\n`;

const FAKES = resolve(process.cwd(), "tests/ops/fixtures/fake-host");
const CRONTAB = "*/5 * * * * manage\n*/15 * * * * scan\n";

const rows = (ids: string[]): string => JSON.stringify(ids.map((id) => ({ id })));
const LISTS = ["kill-switch.paused-ids", "kill-switch.flatten-ids", "kill-switch.broker-failed"];

function seedDatabase(root: string, seed: HostSeed): void {
  writeFileSync(join(root, "active.json"), rows(seed.active ?? []));
  const open = (seed.open ?? []).map((id, i) => ({ id: `p${String(i)}`, algorithm_id: id }));
  writeFileSync(join(root, "open.json"), JSON.stringify(open));
  const mirroring = (seed.mirroringOn ?? []).map((on) => ({ id: "x", live_trading_enabled: on }));
  writeFileSync(join(root, "mirroring.json"), JSON.stringify(mirroring));
  const changed = mirroring.length > 0 ? mirroring : [{ id: "x" }];
  writeFileSync(join(root, "unpause.json"), JSON.stringify(seed.alreadyActive ? [] : changed));
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
  if (seed.saved) {
    writeFileSync(join(host.state, "kill-switch.paused-ids"), `${seed.saved.join("\n")}\n`);
  }
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

/** Touches a marker file the stand-ins read: flatten-http, keep-open-<id>, send-hup, flatten-<id>.json. */
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
  const path = join(host.root, script);
  writeFileSync(path, source);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FAKE_HOST: host.root,
    PATH: `${FAKES}:${process.env.PATH ?? ""}`,
  };
  const run = spawnSync("bash", [path, ...args], { encoding: "utf8", env, input: "" });
  return { status: run.status, stdout: run.stdout };
}

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
