/**
 * scripts/ops/backup.sh, run for real against stand-ins (tests/ops/fixtures/fake-backup) with its
 * absolute paths rewritten into a temporary directory. Nothing reaches Supabase, the Storage Box or
 * ntfy. Pins what decision 0011 promises: every part is attempted, a failed part is never uploaded, a
 * broken night never prunes a good one or writes OK, a failure pushes, and the database password stays
 * out of the output. The fake age writes a header on empty input as the real one does, so only
 * pipefail catches a failed dump.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

// A test runs the real script, some twice, and the whole suite loads the machine.
vi.setConfig({ testTimeout: 30_000 });

const FAKES = resolve(process.cwd(), "tests/ops/fixtures/fake-backup");
const PASSWORD = "s3cret-password";
const URL_LINE = `BACKUP_DATABASE_URL=postgresql://backup_ro.ref:${PASSWORD}@pooler.test:5432/postgres\n`;

interface Run {
  root: string;
  status: number | null;
  output: string;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function prepare(envFile: string, nights: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "qt-fake-backup-"));
  for (const dir of ["app", "log", "state", "lib", "home/.ssh", "uploaded"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, "app", ".env.local"), `${envFile}NTFY_TOPIC=fake\n`);
  writeFileSync(join(root, "log", "scan.log"), "tick\n");
  writeFileSync(join(root, "box-nights"), nights.map((n) => `${n}\n`).join(""));
  return root;
}

function backup(root: string): Run {
  const source = readFileSync(resolve(process.cwd(), "scripts/ops/backup.sh"), "utf8")
    .replaceAll("/opt/quanttrader", join(root, "app"))
    .replaceAll("/var/log/quanttrader", join(root, "log"))
    .replaceAll("/var/lib/quanttrader", join(root, "state"))
    .replaceAll("/usr/local/lib/quanttrader", join(root, "lib"));
  const path = join(root, "backup.sh");
  writeFileSync(path, source);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FAKE_HOST: root,
    HOME: join(root, "home"),
    PATH: `${FAKES}:${process.env.PATH ?? ""}`,
  };
  const run = spawnSync("bash", [path], { encoding: "utf8", env, input: "" });
  return { root, status: run.status, output: `${run.stdout}${run.stderr}` };
}

const logOf = (root: string, name: string): string => {
  const path = join(root, name);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};
const stamped = (root: string): boolean => existsSync(join(root, "state", "backup.last-ok"));
const uploaded = (root: string): string[] => readdirSync(join(root, "uploaded")).sort();

describe("backup.sh, a good night", () => {
  it("uploads the five encrypted parts, verifies them and stamps the night", () => {
    const run = backup(prepare(URL_LINE, []));
    expect(run.status).toBe(0);
    expect(uploaded(run.root)).toEqual([
      "OK",
      "db-auth.dump.age",
      "db-public.dump.age",
      "env.tar.age",
      "host.tar.age",
      "logs.tar.age",
    ]);
    expect(stamped(run.root)).toBe(true);
    expect(logOf(run.root, "curl.log")).toBe("");
  });

  it("uploads only what age wrote", () => {
    const { root } = backup(prepare(URL_LINE, []));
    for (const part of uploaded(root).filter((name) => name !== "OK")) {
      expect(readFileSync(join(root, "uploaded", part), "utf8")).toMatch(
        /^age-encryption\.org\/fake\n/
      );
    }
  });

  it("writes OK after the checksum pass and before the prune", () => {
    const { root } = backup(prepare(URL_LINE, [daysAgo(40)]));
    const calls = logOf(root, "rsync.log");
    expect(calls.indexOf("-rnci")).toBeGreaterThan(-1);
    expect(calls.indexOf("/out/OK")).toBeGreaterThan(calls.indexOf("-rnci"));
    expect(calls.indexOf("--list-only")).toBeGreaterThan(calls.indexOf("/out/OK"));
  });

  it("dumps public whole and auth's two tables as data, through the read-only role", () => {
    const dumps = logOf(backup(prepare(URL_LINE, [])).root, "pg_dump.log");
    expect(dumps).toContain("--schema=public user=backup_ro.ref host=pooler.test");
    expect(dumps).toContain("--data-only --table=auth.users --table=auth.identities");
    expect(dumps).toContain("ssl=require password=set");
  });

  it("prunes only the nights past the 30-day retention", () => {
    const old = daysAgo(31);
    const kept = daysAgo(29);
    const run = backup(prepare(URL_LINE, [old, kept, "not-a-night"]));
    expect(logOf(run.root, "box.log")).toBe(`rm -r nightly/${old}\n`);
  });

  it("keeps the database password out of the output and off pg_dump's arguments", () => {
    const run = backup(prepare(URL_LINE, []));
    expect(run.output).not.toContain(PASSWORD);
    expect(logOf(run.root, "pg_dump.log")).not.toContain(PASSWORD);
  });
});

describe("backup.sh, a bad night", () => {
  const failing = (flag: string): Run => {
    const root = prepare(URL_LINE, [daysAgo(40)]);
    writeFileSync(join(root, flag), "");
    return backup(root);
  };
  const expectFailedNight = (run: Run, part: string): void => {
    expect(run.status).toBe(1);
    expect(run.output).toContain(`${part} FAILED`);
    expect(stamped(run.root)).toBe(false);
    expect(logOf(run.root, "box.log")).toBe("");
    expect(uploaded(run.root)).not.toContain("OK");
    expect(logOf(run.root, "curl.log")).toContain("Priority: urgent");
  };

  it("a failed dump is not uploaded, the other parts are, and nothing is pruned", () => {
    const run = failing("fail-pg_dump");
    expectFailedNight(run, "db-public");
    expect(uploaded(run.root)).not.toContain("db-public.dump.age");
    expect(uploaded(run.root)).toContain("env.tar.age");
  });

  it("a failed archive is not uploaded", () => {
    const run = failing("fail-tar");
    expectFailedNight(run, "env");
    expect(uploaded(run.root)).toEqual(["db-auth.dump.age", "db-public.dump.age"]);
  });

  it("an empty encrypted file counts as a failure", () => {
    expectFailedNight(failing("fail-age"), "db-public");
  });

  it("a failed upload is a failed night", () => {
    expectFailedNight(failing("fail-upload"), "upload");
  });

  it("failed pins are a failed night", () => {
    expectFailedNight(failing("fail-pins"), "pins");
  });

  it("a night that cannot write OK prunes nothing", () => {
    expectFailedNight(failing("fail-mark"), "mark");
  });

  it("a failed prune pushes and leaves no stamp, and the whole night keeps its OK", () => {
    for (const flag of ["fail-list", "fail-rm"]) {
      const run = failing(flag);
      expect(run.status).toBe(1);
      expect(run.output).toContain("prune FAILED");
      expect(stamped(run.root)).toBe(false);
      expect(uploaded(run.root)).toContain("OK");
      expect(logOf(run.root, "curl.log")).toContain("Priority: urgent");
    }
  });

  it("a run that finds the lock held pushes and touches nothing", () => {
    const run = failing("fail-flock");
    expect(run.status).toBe(1);
    expect(run.output).toContain("the lock is held");
    expect(logOf(run.root, "pg_dump.log")).toBe("");
    expect(uploaded(run.root)).toEqual([]);
    expect(logOf(run.root, "curl.log")).toContain("Priority: urgent");
  });

  it("removes a working directory left by a killed run", () => {
    const root = prepare(URL_LINE, []);
    const stale = join(root, "state", "backup.Ab12Cd");
    mkdirSync(stale);
    writeFileSync(join(root, "state", "backup.last-ok"), "earlier\n");
    writeFileSync(join(root, "fail-upload"), "");
    backup(root);
    expect(existsSync(stale)).toBe(false);
    expect(readFileSync(join(root, "state", "backup.last-ok"), "utf8")).toBe("earlier\n");
    expect(existsSync(join(root, "state", "backup.lock"))).toBe(true);
  });

  it("a checksum difference is a failed night", () => {
    const root = prepare(URL_LINE, [daysAgo(40)]);
    writeFileSync(join(root, "verify-diff"), ">fcsT...... db-public.dump.age\n");
    expectFailedNight(backup(root), "verify");
  });

  it("a missing connection line is a failed night that still archives the rest", () => {
    const run = backup(prepare("", [daysAgo(40)]));
    expect(run.status).toBe(1);
    expect(run.output).toContain("BACKUP_DATABASE_URL missing");
    expect(logOf(run.root, "box.log")).toBe("");
    expect(uploaded(run.root)).toContain("env.tar.age");
  });
});
