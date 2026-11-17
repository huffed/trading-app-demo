/**
 * Every environment variable the application reads must be documented by name
 * in .env.example (values never). `make env-check` / CI.
 *
 * Application code (src/, non-test): every `process.env.NAME` must be in
 * .env.example. Live-path scripts take run-time knobs through the environment
 * (ALGO=, MODE=, DRY_RUN=…) which are documented in each script's header, so
 * for scripts only secret-shaped names (*_KEY, *_SECRET, *_TOKEN, *_URL,
 * *_PASSWORD) are required to be in .env.example. NODE_ENV is set by the runtime.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { livePathScriptFiles } from "./checked-scripts.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const RUNTIME_PROVIDED = new Set(["NODE_ENV"]);

const SECRET_SHAPED = /_(KEY|SECRET|TOKEN|URL|PASSWORD)$/;

function appSourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "node_modules") walk(full);
      } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        out.push(relative(repoRoot, full));
      }
    }
  };
  walk(join(repoRoot, "src"));
  return out;
}

/** [file, mustDocumentEveryName] pairs. */
function filesToScan() {
  return [
    ...appSourceFiles().map((f) => [f, true]),
    ...livePathScriptFiles(repoRoot)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => [f, false]),
  ];
}

const documented = new Set(
  readFileSync(join(repoRoot, ".env.example"), "utf8")
    .split("\n")
    .map((line) => line.match(/^#?\s*([A-Z][A-Z0-9_]+)=/)?.[1])
    .filter(Boolean)
);

const missing = new Map();
for (const [file, everyName] of filesToScan()) {
  const text = readFileSync(join(repoRoot, file), "utf8");
  for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) {
    const name = match[1];
    if (documented.has(name) || RUNTIME_PROVIDED.has(name)) continue;
    if (!everyName && !SECRET_SHAPED.test(name)) continue;
    if (!missing.has(name)) missing.set(name, new Set());
    missing.get(name).add(file);
  }
}

if (missing.size === 0) {
  console.log(
    `env-check: every variable read by the code is documented in .env.example (${documented.size} names)`
  );
  process.exit(0);
}
console.error(
  "env-check: variables read by the code but missing from .env.example (add the NAME= line, no value):"
);
for (const [name, files] of [...missing.entries()].sort()) {
  console.error(`  ${name}  ← ${[...files].sort().join(", ")}`);
}
process.exit(1);
