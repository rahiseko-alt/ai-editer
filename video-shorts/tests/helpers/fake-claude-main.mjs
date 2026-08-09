#!/usr/bin/env node
// 偽 claude の本体（固定のスクリプト）— tests/ai-caption-fix-check.mjs の足場
//
// 【なぜ固定の1本にしてあるか】以前はテストごとに「返答を決める JavaScript のソース文字列」を
// 組み立てて実行ファイルへ書き出していた。生成したコードは静的解析（CodeQL の
// "Improper code sanitization"）から見ると「文字列からコードを組み立てている」ので、
// テストの足場であっても指摘が積み上がる。いまはこのファイルを **そのまま写して**
// PATH の `claude` にする（中身はどのテストでも1バイトも変わらない）。
// テストごとに変わるのは、写した実行ファイルの隣に置く **設定 JSON（データだけ）** で、
// 振る舞いは下の BEHAVIORS 表に **名前付きの実装** として持たせ、`kind` で選ぶ。
// ＝外から渡すのはデータのみ・コードは渡さない。
//
// 【設定の置き場所が「環境変数」ではなく「実行ファイルの隣」な理由】
// 製品側の共通口 src/claude-run.mjs は src/claude-safety.mjs の ALLOWED_ENV_VARS で
// 子プロセスの環境変数を絞る（PATH / HOME / TMPDIR など）。任意の環境変数は子まで届かないので、
// 設定のパスを環境変数で渡す経路は使えない。代わりに、この本体は自分自身の置き場所
// （process.argv[1] のフォルダ）にある fake-claude.json を読む。テストは偽 claude ごとに
// 使い捨ての bin フォルダを作るので、これで「テストごとに違う設定」が成立する。
//
// 【設定 JSON の形】
//   { "logDir": "<受け取った argv/stdin を書き出すフォルダ>", "kind": "<下の表の名前>", ...データ }
//     {"kind":"fixed","answer":"<返答本文>"}
//     {"kind":"per-chunk","line":"90\t機械","answer":"...","fallback":"..."}
//     {"kind":"sleep"}                                  応答を返さず眠る（打ち切りの検査用）
//     {"kind":"exit","code":9}                          何も返さず終了コードで落ちる
//     {"kind":"fail","exit":1,"stderr":"..."}           stderr を出して終了コード非0で落ちる
//     {"kind":"digest","critiqueNeedle":"...","critique":"...","draft":"..."}
//     {"kind":"digest-model-gate","modelArg":"--model","exit":1,"stderr":"...",
//      "critiqueNeedle":"...","critique":"...","draft":"..."}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 設定 JSON のファイル名（PATH に置く claude と同じフォルダに置く）。 */
export const CONFIG_FILE = "fake-claude.json";

/** 本物と同じ `--output-format json` の封筒に本文を入れて返す。 */
function reply(answer) {
  return { stdout: JSON.stringify({ result: answer }) };
}

/** stdin の中に「行まるごと一致」する行があるか（`/^…$/m` と同じ判定）。 */
function hasLine(stdin, line) {
  return String(stdin).split("\n").some((l) => l.replace(/\r$/, "") === line);
}

/** digest-editor 用: 講評のプロンプトなら講評を、そうでなければ台本ドラフトを返す。 */
function digestReply(cfg, stdin) {
  return reply(String(stdin).includes(cfg.critiqueNeedle) ? cfg.critique : cfg.draft);
}

/**
 * 名前付きの振る舞い。設定 JSON の `kind` でここから1つ選ぶ。
 * 返り値は {stdout?, stderr?, exit?} か {sleep:true}。
 */
const BEHAVIORS = {
  /** いつでも同じ本文を返す。 */
  fixed: (cfg) => reply(cfg.answer),

  /** 渡ってきたかたまり（プロンプト）に目印の行があるときだけ別の本文を返す。 */
  "per-chunk": (cfg, ctx) => reply(hasLine(ctx.stdin, cfg.line) ? cfg.answer : cfg.fallback),

  /** 応答を返さず眠り続ける。 */
  sleep: () => ({ sleep: true }),

  /** 何も返さず終了コードで落ちる（起動失敗の再現）。 */
  exit: (cfg) => ({ exit: cfg.code }),

  /** stderr を出して終了コード非0で落ちる。 */
  fail: (cfg) => ({ exit: cfg.exit, stderr: cfg.stderr }),

  /** digest-editor の2種類の呼び出し（台本ドラフト / 講評）に答える。 */
  digest: (cfg, ctx) => digestReply(cfg, ctx.stdin),

  /** --model が付いた呼び出しだけ失敗させ、付いていなければ digest として答える。 */
  "digest-model-gate": (cfg, ctx) =>
    ctx.argv.includes(cfg.modelArg)
      ? { exit: cfg.exit, stderr: cfg.stderr }
      : digestReply(cfg, ctx.stdin),
};

function readConfig() {
  const here = path.dirname(path.resolve(process.argv[1]));
  return JSON.parse(fs.readFileSync(path.join(here, CONFIG_FILE), "utf-8"));
}

function main() {
  const cfg = readConfig();
  let buf = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (c) => {
    buf += c;
  });
  process.stdin.on("end", () => {
    const argv = process.argv.slice(2);
    // 受け取った引数と stdin を記録する（検査側が「何を渡したか」を実物で読めるようにする）。
    const n = fs.readdirSync(cfg.logDir).length;
    fs.writeFileSync(
      path.join(cfg.logDir, `${String(n).padStart(3, "0")}.json`),
      JSON.stringify({ argv, stdin: buf }),
      "utf-8",
    );

    const behave = Object.prototype.hasOwnProperty.call(BEHAVIORS, cfg.kind)
      ? BEHAVIORS[cfg.kind]
      : null;
    if (!behave) {
      // 設定の書き間違いを黙って「それらしい応答」にしない（偽の緑を作らない）。
      process.stderr.write(`fake claude: 知らない kind: ${JSON.stringify(cfg.kind)}\n`);
      process.exitCode = 97;
      return;
    }

    const r = behave(cfg, { argv, stdin: buf });
    if (r.sleep) {
      setInterval(() => {}, 1000);
      return;
    }
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.stdout) process.stdout.write(r.stdout);
    // process.exit() は書き込みが流れ切る前にプロセスを畳んで stderr を切り落とすことがあるので、
    // 終了コードだけ立てて自然に終わらせる。
    process.exitCode = r.exit ?? 0;
  });
}

// PATH へ写された実行ファイルとして起動されたときだけ動く。
// 検査側から import されたとき（CONFIG_FILE を参照するため）には動かない。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
