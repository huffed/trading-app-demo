/**
 * scripts/ops/ops-health.sh, run for real against stand-ins (tests/ops/fixtures/fake-health) with its absolute
 * paths rewritten into a temporary directory. Nothing reaches Supabase, the host or ntfy. Pins the paused-pairs
 * count (operator, 2026-11-17): the watchlist pairs auto-paused on an active algorithm, read through the backups'
 * read-only role with the server verified, high priority above zero, "?" and high priority when the read fails,
 * never 0, and the database password kept out of argv and the push.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Each test runs the real script, and the whole suite loads the machine.
vi.setConfig({ testTimeout: 30_000 });

const FAKES = resolve(process.cwd(), "tests/ops/fixtures/fake-health");
const PASSWORD = "s3cret-password";
const URL_LINE = `BACKUP_DATABASE_URL=postgresql://backup_ro.ref:${PASSWORD}@pooler.test:5432/postgres\n`;
const LIVE = "1111111111111111111111111111111111111111";

interface Run {
  root: string;
  status: number | null;
  output: string;
  push: string;
}

interface Setup {
  envFile?: string;
  rows?: string[];
  failRead?: boolean;
  withCa?: boolean;
}

function prepare(setup: Setup): string {
  const root = mkdtempSync(join(tmpdir(), "qt-fake-health-"));
  for (const dir of ["app", "log", "state", "lib"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, "app", ".env.local"), `${setup.envFile ?? URL_LINE}NTFY_TOPIC=fake\n`);
  if (setup.withCa ?? true) {
    writeFileSync(join(root, "lib", "supabase-prod-ca-2021.crt"), "a stand-in certificate\n");
  }
  writeFileSync(join(root, "lib", "backup.sh"), "# installed\n");
  writeFileSync(join(root, "state", "backup.last-ok"), "2026-11-17T02:23:12Z\n");
  writeFileSync(join(root, "log", "live.sha"), `${LIVE}\n`);
  writeFileSync(join(root, "log", "running.sha"), `${LIVE}\n`);
  writeFileSync(join(root, "log", "deploys.log"), "2026-11-07T15:00:24Z OK ref=origin/dev\n");
  if (setup.rows) {
    writeFileSync(join(root, "psql.out"), setup.rows.map((row) => `${row}\n`).join(""));
  }
  if (setup.failRead === true) {
    writeFileSync(join(root, "fail-psql"), "");
  }
  return root;
}

function health(root: string): Run {
  const source = readFileSync(resolve(process.cwd(), "scripts/ops/ops-health.sh"), "utf8")
    .replaceAll("/opt/quanttrader", join(root, "app"))
    .replaceAll("/var/log/quanttrader", join(root, "log"))
    .replaceAll("/var/lib/quanttrader", join(root, "state"))
    .replaceAll("/usr/local/lib/quanttrader", join(root, "lib"))
    .replaceAll("/var/run/reboot-required", join(root, "reboot-required"));
  const path = join(root, "ops-health.sh");
  writeFileSync(path, source);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FAKE_HOST: root,
    PATH: `${FAKES}:${process.env.PATH ?? ""}`,
  };
  const run = spawnSync("bash", [path], { encoding: "utf8", env, input: "" });
  return {
    root,
    status: run.status,
    output: `${run.stdout}${run.stderr}`,
    push: logOf(root, "curl.log"),
  };
}

function logOf(root: string, name: string): string {
  const path = join(root, name);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

describe("ops-health.sh, the paused-pairs count", () => {
  it("reads 0 and keeps the daily summary at default priority when no pair is paused", () => {
    const run = health(prepare({ rows: [] }));
    expect(run.status).toBe(0);
    expect(run.output).toContain("paused-pairs=0 ");
    expect(run.push).toContain("Priority: default");
    expect(run.push).toContain("Title: quanttrader-prod daily: OK");
  });

  it("counts the pairs, lists them and pushes at high priority when one or more is paused", () => {
    const rows = [
      "Engulfing r080 / XAU/USD since 2026-11-16",
      "Sweep reclaim / XAU/USD since 2026-11-12",
    ];
    const run = health(prepare({ rows }));
    expect(run.status).toBe(0);
    const listed =
      "(Engulfing r080 / XAU/USD since 2026-11-16; Sweep reclaim / XAU/USD since 2026-11-12)";
    expect(run.output).toContain(`paused-pairs=2 ${listed}`);
    expect(run.push).toContain("Priority: high");
    expect(run.push).toContain(`2 pair(s) auto-paused ${listed}`);
  });

  it("says ? and pushes at high priority when the read fails, never 0", () => {
    const run = health(prepare({ failRead: true }));
    expect(run.output).toContain("paused-pairs=? ");
    expect(run.output).not.toContain("paused-pairs=0");
    expect(run.push).toContain("Priority: high");
    expect(run.push).toContain("paused pairs not read");
  });

  it("says ? without the read-only role's URL, and without the CA, and does not call psql", () => {
    for (const setup of [{ envFile: "" }, { withCa: false }]) {
      const run = health(prepare({ ...setup, rows: [] }));
      expect(run.output).toContain("paused-pairs=? ");
      expect(run.push).toContain("paused pairs not read");
      expect(logOf(run.root, "psql.log")).toBe("");
    }
  });

  it("reads through the read-only role, verifying the server against the installed CA, with GSSAPI off", () => {
    const run = health(prepare({ rows: [] }));
    const call = logOf(run.root, "psql.log");
    const ca = join(run.root, "lib", "supabase-prod-ca-2021.crt");
    expect(call).toContain(
      `user=backup_ro.ref host=pooler.test db=postgres ssl=verify-full ca=${ca} gss=disable`
    );
    expect(call).toContain("password=set");
    expect(call).toContain("where w.auto_paused and a.status = 'active'");
    expect(call).toContain("-X -q -A -t -v ON_ERROR_STOP=1 -c ");
  });

  it("keeps the database password out of psql's arguments, the output and the push", () => {
    const run = health(prepare({ rows: ["Engulfing r080 / XAU/USD since 2026-11-16"] }));
    expect(logOf(run.root, "psql.log")).not.toContain(PASSWORD);
    expect(run.output).not.toContain(PASSWORD);
    expect(run.push).not.toContain(PASSWORD);
  });
});
