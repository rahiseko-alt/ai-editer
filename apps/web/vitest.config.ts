import { defineConfig } from "vitest/config";

// JSX/TSX は esbuild の automatic runtime で変換する。
// テストは tests/ 配下のみを対象にし、Next のルート（app/）とは分離する。
export default defineConfig({
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
