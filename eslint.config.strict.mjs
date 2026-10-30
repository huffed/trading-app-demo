/**
 * The TARGET rule set (docs/DEBT.md §4). Every file added to the repo is held
 * to it from its first PR: pre-commit runs it on staged new files and CI runs
 * it on files added in a PR (`make lint-strict FILES=...`). Existing files
 * stay on eslint.config.mjs (the baseline) until they are migrated, one PR at
 * a time, after the audit verdict. Settings here only ever get stricter.
 */
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import baseConfig from "./eslint.config.mjs";

export default defineConfig([
  ...baseConfig,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Size and shape — the "smallest code that is obviously right" rules.
      complexity: ["error", 10],
      "max-depth": ["error", 4],
      "max-params": ["error", 5],
      "max-lines": ["error", { max: 300, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": [
        "error",
        { max: 80, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],
      "no-nested-ternary": "error",
      curly: ["error", "multi-line"],

      // One logging style: the logger, never console (scripts excepted below).
      "no-console": "error",

      // Types: no escapes, explicit boundaries.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "as", objectLiteralTypeAssertions: "never" },
      ],
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",

      // Errors are raised, not swallowed.
      "no-empty": ["error", { allowEmptyCatch: false }],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/only-throw-error": "error",

      // Imports stay ordered and acyclic.
      "import-x/order": "error",
      "import-x/no-cycle": ["error", { maxDepth: 10, ignoreExternal: true }],
    },
  },
  {
    // Scripts print to stdout by design; everything else in the target set applies.
    files: ["scripts/**/*.ts", "scripts/**/*.mjs"],
    rules: { "no-console": "off" },
  },
  {
    // JS config/tooling files have no type information.
    files: ["**/*.mjs", "**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
]);
