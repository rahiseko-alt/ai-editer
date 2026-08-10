// video-shorts の ESLint 設定（flat config, ESLint 9系）。
// G-TESTINFRA-LINT: video-shortsパッケージにLintが導入され、
// `pnpm --filter video-shorts lint` が実コードを検査する（echo/プレースホルダでの緑ではない）。
//
// プレーンJS（TypeScript未導入）のため、厳格な型系・スタイル系ルール一式は導入しない。
// 既存コード全体を落とさない現実的な最小セット
// （未使用変数検出・use-before-define・構文/組み込みルールの recommended）に絞る。
//
// ディレクトリで実行環境が分かれるため languageOptions を分けている。
//   - server/*.mjs, src/*.mjs, tests/*.mjs, pipeline.mjs, build-dist.mjs 等: Node.js (ESM)
//   - ui/app.js, webapp-mockup/app.js, install/consent.js: ブラウザ（<script src> の素の script）

import js from "@eslint/js";
import globals from "globals";

export default [
  {
    // 生成物・サードパーティ同梱物・依存はそもそも lint 対象外。
    ignores: [
      "node_modules/**",
      "**/node_modules/**",
      "output/**",
      "work/**",
      "samples/**",
      "webapp-mockup/vendor/**",
      "docs/**",
    ],
  },
  js.configs.recommended,
  {
    // catch(_) {} で意図的にエラーを握りつぶす箇所が既存コードに多数ある
    // （例外の詳細を使わない設計判断。空catch自体を禁止すると既存コード全体が落ちる）。
    // 未使用変数は "_" 始まりの変数名・catch束縛は許容する（意図的な破棄の合図として扱う）。
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-use-before-define": [
        "error",
        { functions: false, classes: false, variables: true },
      ],
      // 日本語コメント/文字列/正規表現には意図的な全角スペース（U+3000）が普通に出てくる
      // （例: 全角スペースも空白として扱う正規表現）。実コード（識別子等）側の
      // 意図しない不可視文字だけを拾うよう、文字列・コメント・テンプレート・正規表現は対象外にする。
      "no-irregular-whitespace": [
        "error",
        { skipStrings: true, skipComments: true, skipTemplates: true, skipRegExps: true },
      ],
    },
  },
  {
    // Node.js 上で動くESMスクリプト群（サーバ・パイプライン・テスト等）。
    // 一部のテスト/計測スクリプトは Playwright の page.evaluate(() => ...) に渡す
    // コールバックをそのまま同じファイル内に書いており、そこだけブラウザ実行になる
    // （実行時コンテキストがファイル内で混在する）。誤検知を避けるため node+browser 両方の
    // グローバルを許容する（現実的な最小設定。ファイル分割までは求めない）。
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  {
    // ブラウザで <script src="..."></script> として素で読み込まれる非モジュールJS
    files: ["ui/app.js", "webapp-mockup/app.js", "install/consent.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: {
        ...globals.browser,
      },
    },
  },
];
