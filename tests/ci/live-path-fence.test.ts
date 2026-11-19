/**
 * scripts/ci/live-path-fence.sh, the job .github/workflows/fence.yml runs on every pull request into dev
 * (docs/decisions/0015): a PR that changes a path in .claude/hooks/live-paths.txt fails unless
 * review/VERDICT.md is on the base branch and the title carries the marker. Each case gives the script a base
 * checkout and the API's file list and asserts its exit code: 0 passes, 1 is fenced, 2 is unreadable input.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fencedPaths, HEAD, makeBase, MARKER, modified, runGate } from "./live-path-fence-harness";

const ENGINE = "src/lib/scan/engine.ts";

describe("live-path-fence.sh: which diffs are fenced", () => {
  it("a diff touching src/lib/scan fails", () => {
    const run = runGate({ pages: [modified("docs/DEBT.md", ENGINE)] });
    expect(run.status).toBe(1);
    expect(fencedPaths(run)).toEqual([ENGINE]);
  });
  it("a diff touching only tests/ and docs/ passes", () => {
    const run = runGate({
      pages: [modified("tests/characterisation/live-entry.test.ts", "docs/DEV_SETUP.md")],
    });
    expect(run.status).toBe(0);
    expect(fencedPaths(run)).toEqual([]);
  });
  it("a deleted fenced file counts", () => {
    const run = runGate({
      pages: [[{ filename: "supabase/migrations/00001_x.sql", status: "removed" }]],
    });
    expect(run.status).toBe(1);
  });
  it("a rename out of a fenced path counts, under its old name", () => {
    const run = runGate({
      pages: [[{ filename: "docs/engine.ts", previous_filename: ENGINE, status: "renamed" }]],
    });
    expect(run.status).toBe(1);
    expect(fencedPaths(run)).toEqual([ENGINE]);
  });
  it("a rename into a fenced path counts", () => {
    const run = runGate({
      pages: [[{ filename: ENGINE, previous_filename: "docs/engine.ts", status: "renamed" }]],
    });
    expect(run.status).toBe(1);
  });
  it("a fenced path on a later API page counts", () => {
    const run = runGate({
      pages: [modified("docs/a.md"), modified("docs/b.md", "scripts/scan-cron.sh")],
    });
    expect(run.status).toBe(1);
    expect(fencedPaths(run)).toEqual(["scripts/scan-cron.sh"]);
  });
  it("a fenced path in another case counts, as the hook folds case on macOS", () => {
    expect(runGate({ pages: [modified("SRC/lib/Scan/engine.ts")] }).status).toBe(1);
  });
  it("the title is data: shell syntax in it runs nothing", () => {
    const flag = join(mkdtempSync(join(tmpdir(), "fence-title-")), "ran");
    const title = `fix: $(touch ${flag}) \`touch ${flag}\` ${MARKER}`;
    expect(runGate({ pages: [modified(ENGINE)], title }).status).toBe(1);
    expect(existsSync(flag)).toBe(false);
  });
});

describe("live-path-fence.sh: a fenced diff passes only with the verdict on the base and the marker", () => {
  const cases: [string, boolean, string, number][] = [
    ["neither", false, "fix(scan): x", 1],
    ["the verdict only", true, "fix(scan): x", 1],
    ["the marker only", false, `fix(scan): x ${MARKER}`, 1],
    ["both", true, `fix(scan): x ${MARKER}`, 0],
    ["both, the marker in another case", true, "fix(scan): x [Changes fenced live paths]", 1],
    ["both, the marker without its brackets", true, "fix(scan): x, changes fenced live paths", 1],
  ];
  for (const [label, verdict, title, expected] of cases) {
    it(label, () => {
      expect(runGate({ pages: [modified(ENGINE)], verdict, title }).status).toBe(expected);
    });
  }
  it("a symlink at review/VERDICT.md is not the verdict", () => {
    const base = makeBase(false);
    mkdirSync(join(base, "review"));
    symlinkSync(
      join(base, ".claude", "hooks", "live-paths.txt"),
      join(base, "review", "VERDICT.md")
    );
    expect(runGate({ pages: [modified(ENGINE)], base, title: MARKER }).status).toBe(1);
  });
  it("an unfenced diff passes without either", () => {
    expect(runGate({ pages: [modified("ops/crontab", "scripts/ops/deploy.sh")] }).status).toBe(0);
  });
});

describe("live-path-fence.sh: fails closed on input it cannot read", () => {
  it("a list shorter than the PR's changed_files (the API stops at 3,000)", () => {
    expect(runGate({ pages: [modified("docs/a.md")], count: 3001 }).status).toBe(2);
  });
  it("a file list that is not JSON", () => {
    expect(runGate({ pages: "not json", count: 1 }).status).toBe(2);
  });
  it("a page that is not an array of files", () => {
    expect(runGate({ pages: '{"message":"Not Found"}', count: 0 }).status).toBe(2);
  });
  it("a path holding a newline, which a line-based match could split", () => {
    expect(runGate({ pages: [modified("scripts/a\nb-cron.sh")] }).status).toBe(2);
  });
  it("a base with no live-paths.txt", () => {
    const base = makeBase(false);
    rmSync(join(base, ".claude"), { recursive: true });
    expect(runGate({ pages: [modified("docs/a.md")], base }).status).toBe(2);
  });
  it("a live-paths.txt with no globs", () => {
    const base = makeBase(false);
    writeFileSync(join(base, ".claude", "hooks", "live-paths.txt"), "# only a comment\n");
    expect(runGate({ pages: [modified("docs/a.md")], base }).status).toBe(2);
  });
});

describe("live-path-fence.sh: the list is the one of the commit the check reports on", () => {
  const moved = "b".repeat(40);
  it("a head that moved before the list fails closed", () => {
    expect(runGate({ pages: [modified("docs/a.md")], heads: [moved, moved] }).status).toBe(2);
  });
  it("a head that moved while the files were listed fails closed", () => {
    expect(runGate({ pages: [modified("docs/a.md")], heads: [HEAD, moved] }).status).toBe(2);
  });
});

describe("live-path-fence.sh: warnings and the list's last line", () => {
  it("warns on the fence's files, on another workflow and on the verdict, each in its own words", () => {
    const run = runGate({
      pages: [
        modified(".github/workflows/fence.yml", ".github/workflows/ci.yml", "review/VERDICT.md"),
      ],
    });
    expect(run.status).toBe(0);
    const warnings = run.output.split("\n").filter((line) => line.startsWith("::warning"));
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain("fence.yml changes the fence itself");
    expect(warnings[1]).toContain(
      "ci.yml changes a workflow; one on pull_request runs this PR's own copy"
    );
    expect(warnings[2]).toContain("review/VERDICT.md adds or changes the audit verdict");
  });
  it("a glob on a last line with no newline still fences", () => {
    const base = makeBase(false);
    writeFileSync(join(base, ".claude", "hooks", "live-paths.txt"), "src/lib/scan/**\ndocs/**");
    expect(runGate({ pages: [modified("docs/a.md")], base }).status).toBe(1);
  });
});
