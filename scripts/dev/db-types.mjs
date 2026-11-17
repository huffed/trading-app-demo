/**
 * Generated DB types ↔ migrations contract.
 *
 *   node scripts/dev/db-types.mjs check      exit 1 if supabase/migrations/ changed since the
 *                                            types were generated (CI runs this)
 *   node scripts/dev/db-types.mjs stamp      rewrite supabase/types.manifest.json for the current
 *                                            migrations (run after regenerating the types)
 *   node scripts/dev/db-types.mjs generate   regenerate src/lib/supabase/database.types.ts from the
 *                                            live project with the Supabase CLI, then stamp
 *
 * The manifest records a sha-256 over the sorted migration files. The check is
 * deliberately simple: it proves the types were regenerated AFTER the last
 * migration landed, with no database access in CI. It cannot prove the live
 * database has every migration applied — that is the operator's manual apply
 * step (docs/DEV_SETUP.md §10).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const migrationsDir = join(repoRoot, "supabase", "migrations");
const manifestPath = join(repoRoot, "supabase", "types.manifest.json");
const typesPath = join(repoRoot, "src", "lib", "supabase", "database.types.ts");

function migrationsDigest() {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const hash = createHash("sha256");
  for (const f of files) {
    hash.update(f);
    hash.update("\n");
    hash.update(readFileSync(join(migrationsDir, f)));
  }
  return { sha256: hash.digest("hex"), count: files.length, latest: files.at(-1) ?? null };
}

function readManifest() {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function stamp(generator) {
  const digest = migrationsDigest();
  const manifest = {
    generated_at: new Date().toISOString(),
    generator,
    migration_count: digest.count,
    latest_migration: digest.latest,
    migrations_sha256: digest.sha256,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`stamped ${manifestPath} (${digest.count} migrations, latest ${digest.latest})`);
}

function check() {
  const manifest = readManifest();
  const digest = migrationsDigest();
  if (manifest.migrations_sha256 === digest.sha256) {
    console.log(`db-types: in sync (${digest.count} migrations, latest ${digest.latest})`);
    return 0;
  }
  console.error(
    [
      "db-types: STALE — supabase/migrations/ changed since src/lib/supabase/database.types.ts was generated.",
      `  manifest: ${manifest.migration_count} migrations, latest ${manifest.latest_migration}, generated ${manifest.generated_at}`,
      `  now:      ${digest.count} migrations, latest ${digest.latest}`,
      "  Apply the migration to the project, then run `make db-types` and commit the result.",
    ].join("\n")
  );
  return 1;
}

function generate() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const ref = url?.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
  if (!ref) {
    console.error(
      "db-types: NEXT_PUBLIC_SUPABASE_URL is not set (run via `make db-types`, which loads .env.local)."
    );
    return 2;
  }
  if (!process.env.SUPABASE_ACCESS_TOKEN) {
    console.error(
      "db-types: SUPABASE_ACCESS_TOKEN is not set. Create a personal access token at https://supabase.com/dashboard/account/tokens and export it for this shell only."
    );
    return 2;
  }
  const types = execFileSync(
    "pnpm",
    ["dlx", "supabase@2", "gen", "types", "typescript", "--project-id", ref, "--schema", "public"],
    { encoding: "utf8", cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }
  );
  const header = [
    "/**",
    " * GENERATED — do not edit. `make db-types` regenerates this file from the live",
    " * project schema; `make db-types-check` (CI) fails when supabase/migrations/",
    " * changed after it was generated. Manifest: supabase/types.manifest.json.",
    " */",
    "",
  ].join("\n");
  writeFileSync(typesPath, header + types);
  console.log(`wrote ${typesPath}`);
  stamp("supabase cli gen types typescript (make db-types)");
  return 0;
}

const commands = {
  check,
  generate,
  stamp: () => {
    stamp(process.argv[3] ?? "manual stamp");
    return 0;
  },
};
const run = commands[process.argv[2]];
if (!run) {
  console.error("usage: db-types.mjs check | stamp | generate");
  process.exit(2);
}
process.exit(run());
