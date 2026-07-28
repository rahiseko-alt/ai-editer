import tseslint from "typescript-eslint";

// packages/ui の本物の lint（echo の置き換え）。
// 型情報なしの recommended で軽量に回す（source-only パッケージ）。
export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**"] },
  ...tseslint.configs.recommended,
);
