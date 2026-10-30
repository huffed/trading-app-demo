import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Unit tests sit beside their subject under src/; cross-module
    // characterisation and golden-file tests live under tests/; script tests
    // under scripts/. The research archive is never executed.
    include: ["src/**/*.test.ts", "tests/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "scripts/archive/**", "scripts/ad-hoc/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
