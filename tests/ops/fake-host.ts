/**
 * Runs the real scripts/ops kill-switch scripts on a throwaway fake host: their absolute paths are
 * rewritten into a temporary directory and tests/ops/fixtures/fake-host puts stand-ins for curl,
 * crontab, systemctl, sudo and id first on PATH. Nothing here reaches the VPS, Supabase or ntfy.
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
  open?: number;
  saved?: string[];
  crontab?: boolean;
  service?: "active" | "inactive";
  mirroringOn?: boolean[];
}

export interface RunResult {
  status: number | null;
  stdout: string;
}

const FAKES = resolve(process.cwd(), "tests/ops/fixtures/fake-host");
const CRONTAB = "*/5 * * * * manage\n*/15 * * * * scan\n";
const ENV_FILE =
  "NEXT_PUBLIC_SUPABASE_URL=https://supabase.test\nSUPABASE_SERVICE_ROLE_KEY=fake\nCRON_SECRET=fake\nNTFY_TOPIC=fake\n";

const rows = (ids: string[]): string => JSON.stringify(ids.map((id) => ({ id })));

export function makeHost(seed: HostSeed = {}): FakeHost {
  const root = mkdtempSync(join(tmpdir(), "qt-fake-host-"));
  const host = { root, state: join(root, "state"), logs: join(root, "log") };
  for (const dir of [host.state, host.logs, join(root, "app")]) {
    mkdirSync(dir);
  }
  writeFileSync(join(root, "app", ".env.local"), ENV_FILE);
  writeFileSync(join(root, "active.json"), rows(seed.active ?? []));
  writeFileSync(
    join(root, "open.json"),
    rows(Array.from({ length: seed.open ?? 0 }, (_, i) => `p${String(i)}`))
  );
  writeFileSync(join(root, "service"), `${seed.service ?? "active"}\n`);
  const mirroring = (seed.mirroringOn ?? []).map((on) => ({ id: "x", live_trading_enabled: on }));
  writeFileSync(join(root, "mirroring.json"), JSON.stringify(mirroring));
  if (seed.crontab ?? true) {
    writeFileSync(join(root, "crontab"), CRONTAB);
  }
  if (seed.saved) {
    writeFileSync(join(host.state, "kill-switch.paused-ids"), `${seed.saved.join("\n")}\n`);
  }
  return host;
}

/** Writes the flatten route's response for one algorithm, as the fake curl serves it. */
export function flattenAnswers(host: FakeHost, id: string, statuses: string[]): void {
  const results = statuses.map((status) => ({
    ticker: "XAU/USD",
    broker_position_id: "1",
    status,
  }));
  writeFileSync(
    join(host.root, `flatten-${id}.json`),
    JSON.stringify({ flattened: results.length, results })
  );
}

/** Makes one fake-curl call fail the way `curl -f` does. */
export function failCall(host: FakeHost, name: string): void {
  writeFileSync(join(host.root, `fail-${name}`), "");
}

/** Makes the ledger unwritable: `>>` onto a directory fails. */
export function breakLedger(host: FakeHost): void {
  mkdirSync(join(host.logs, "deploys.log"));
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

export const ledger = (host: FakeHost): string => {
  const path = join(host.logs, "deploys.log");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};

export const curlCalls = (host: FakeHost): string[] =>
  readFileSync(join(host.root, "curl.log"), "utf8").trim().split("\n");

export const savedIds = (host: FakeHost): string[] => {
  const path = join(host.state, "kill-switch.paused-ids");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
};
