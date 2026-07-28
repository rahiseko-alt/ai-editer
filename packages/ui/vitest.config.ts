import { defineConfig } from "vitest/config";

// JSX/TSX は esbuild の automatic runtime（react/jsx-runtime）で変換する。
// source（button.tsx）が `import React` を書かない前提のため classic ではなく automatic。
export default defineConfig({
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
