import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier";
import importPlugin from "eslint-plugin-import-x";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,

  {
    plugins: {
      "import-x": importPlugin,
    },
    rules: {
      // --- File & function size limits ---
      "max-lines": ["warn", { max: 300, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": [
        "warn",
        { max: 80, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],

      // --- No leftover debugging ---
      "no-console": ["warn", { allow: ["warn", "error"] }],

      // --- Unused variables (stricter) ---
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],

      // --- Strict typing (CB.E1, 2026-06-20) ---
      // Promote `any` from inherited-warn to explicit-error. Every existing
      // site is already gated by `// eslint-disable-next-line` (verified at
      // CB.E1 landing time: 5 `as any` + 6 `: any` sites, all in
      // src/components/chart/* + portfolio-backtest.ts + axis-mapper.ts,
      // each with an explicit suppression). The promotion is a
      // regression-prevention guardrail — future drift surfaces as a hard
      // error rather than blending into the warning baseline.
      "@typescript-eslint/no-explicit-any": "error",
      // Forbid inline `as { ... }` object-literal casts (the pattern that
      // bypasses excess-property checks). `as Type` on a typed expression
      // is still allowed; only freshly-literalled assertions are blocked.
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        {
          assertionStyle: "as",
          objectLiteralTypeAssertions: "never",
        },
      ],
      // `explicit-function-return-type` was attempted with the standard
      // expression/HOF allowances and still added ~620 inherited warnings
      // (supabase client wrappers, theme providers, every small arrow
      // callback). The signal/noise ratio doesn't justify it on a single-
      // operator codebase where strong inference catches almost all return
      // mistakes via the build. Skipped at CB.E1 landing 2026-06-20; if
      // adopted later, scope first to lib/server-actions only.
      //
      // Catch runtime import cycles. `eslint-plugin-import-x` v4 doesn't
      // expose `ignoreTypeImports`, but its TS resolver classifies pure
      // type-only edges as severed by default, so the 7 known type-only
      // cycles (CB.V1, runtime-safe) stay quiet under standard settings.
      // maxDepth caps graph walking so lint doesn't slow on the full repo;
      // ignoreExternal keeps node_modules out of the cycle search.
      "import-x/no-cycle": [
        "error",
        {
          maxDepth: 10,
          ignoreExternal: true,
          allowUnsafeDynamicCyclicDependency: false,
        },
      ],

      // --- Import hygiene ---
      "import-x/order": [
        "warn",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index", "type"],
          pathGroups: [
            { pattern: "react", group: "external", position: "before" },
            { pattern: "next/**", group: "external", position: "before" },
            { pattern: "@/**", group: "internal", position: "before" },
          ],
          pathGroupsExcludedImportTypes: ["react"],
          "newlines-between": "never",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
      "import-x/no-duplicates": "error",

      // --- Code quality ---
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      curly: ["warn", "multi-line"],
      "no-nested-ternary": "warn",
      "no-unneeded-ternary": "warn",

      // --- React ---
      "react/self-closing-comp": "warn",
      "react/jsx-boolean-value": ["warn", "never"],
      "react/jsx-curly-brace-presence": ["warn", { props: "never", children: "never" }],
    },
  },

  // Override default ignores of eslint-config-next. `scripts/` is one-off
  // CLI tooling (data analysis, ad-hoc maintenance) — console.log is the
  // intended output channel there, and the production code rules don't fit.
  // database.types.ts is generated (Supabase MCP) — never hand-edited.
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "scripts/**",
    "src/lib/supabase/database.types.ts",
  ]),

  // CB.E2 (Stage 0.4) — per-file `max-lines: off` overrides for legitimate
  // single-responsibility files. These are not splittable without harming
  // cohesion: portfolio-backtest is the B.1.9 validated harness (only
  // canonical caller), llm-trader-prompts is the version registry, markets
  // is a lookup table, types/algorithm is the central type registry.
  {
    files: [
      "src/lib/market-data/portfolio-backtest.ts",
      "src/lib/scan/llm-trader-prompts.ts",
      "src/lib/constants/markets.ts",
      "src/types/algorithm.ts",
    ],
    rules: {
      "max-lines": "off",
    },
  },

  // CB.E3 (Stage 0.4) — test files have legitimate reasons to be long
  // (table-driven test cases, repeated setup) and tests-per-function ~80
  // line cap is hostile to describe/it blocks. Disable both for *.test.*.
  // CB.E3.b (CB.T1.2, 2026-06-22) — also disable consistent-type-assertions:
  // the rule's intent is to prevent excess-property bypass on PRODUCTION
  // object literals; test fixtures legitimately need shape-mock casts
  // (`{ ... } as EntryContext`, `{ ... } as unknown as Partial<X>`) to
  // construct partial mocks that satisfy callers without enforcing full
  // type membership. The production hardening (CB.E1) covers the actual
  // attack surface.
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "max-lines": "off",
      "max-lines-per-function": "off",
      "@typescript-eslint/consistent-type-assertions": "off",
    },
  },

  // CB.L5 (Stage 0.4) — the leveled logger wraps all console methods
  // (debug, info, warn, error) by design; the file is the ONLY caller
  // that should reach console.debug + console.info directly. Disable
  // no-console for this single file rather than silencing the rule
  // globally or losing the level distinction.
  {
    files: ["src/lib/logger.ts"],
    rules: {
      "no-console": "off",
    },
  },

  // CB.E2.b (CB.H2 closure, 2026-06-22) — `max-lines-per-function` measures
  // logic complexity, but React component renders measure JSX-tree layout
  // depth and API route handlers are linear validate-→-query-→-format-→-
  // respond pipelines at the system boundary. Both categories produce false
  // positives at the 80-LOC cap (4 UI components + 3 API routes flagged
  // post-marathon, none of which benefit from sub-splits). Same exemption
  // pattern as CB.E2 (single-responsibility files where line counts measure
  // entry count, not complexity).
  {
    files: ["src/components/**/*.tsx", "src/app/**/*.tsx", "src/app/**/route.ts"],
    rules: {
      "max-lines-per-function": "off",
    },
  },
]);

export default eslintConfig;
