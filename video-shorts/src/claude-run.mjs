// video-shorts claude -p の起動口（守りを掛けた共通の入口）
//
// 【なぜ1箇所に集めるか】claude -p へ渡すのは動画の音声から起こした非信頼なテキストで、
// 起動のたびに「ツール無効化(--tools "")・env の allowlist・ジョブ専用の隔離 cwd・
// タイムアウト・終了コード検査」を書き写す必要がある。書き写しは増えるほど写し漏れる。
// 漏れた1箇所だけが素通しになっても、他の箇所を見ている検査は緑のままなので気づけない。
// 起動の作法をここへ集め、呼び出し側は「渡す文」と「作業場所」だけを決める。
//
// 起動口がここ1つであることは tests/ai-caption-fix-check.mjs（葉E）が
// video-shorts 配下の *.mjs を走査して機械で見張る。
//
// 呼び出し側ごとに違う引数（例: src/digest-editor.mjs の `--model <上位モデル>` の pin）は
// extraArgs で足す。足せるのは引数だけで、守り（NO_TOOLS_ARGS / buildSafeEnv / 隔離 cwd /
// 打ち切り）は呼び出し側から外せない。「自前で spawn すれば守りを書き写さずに済む」経路を
// 残さないための逃がし弁で、これがあるので起動口は本当にここ1つで足りる。

import { spawn } from "node:child_process";
import { buildSafeEnv, NO_TOOLS_ARGS } from "./claude-safety.mjs";

/** 1 回の claude -p 呼び出しに許す時間の既定（server/claude-select.mjs の従来値と同じ）。 */
export const DEFAULT_CLAUDE_TIMEOUT_MS = 300_000;

/**
 * claude -p を1回起動し、返答の本文（文字列）を返す。
 *
 * --strict-mcp-config（--mcp-config 未指定）で MCP サーバーをゼロにする。
 *   真因: 毎回の claude -p 起動で serena 等 MCP ブート（150s+）が走り、入力が小さくても
 *   300s タイムアウトを食い潰していた。MCP を切ると 300s→5.5s（実測）。モデルは変えない＝品質不変。
 * ※ --bare は MCP/hook を全スキップして更に軽いが OAuth ログインまで剥がし "Not logged in" になる
 *   （サブスク無料運用が壊れる）ため使用不可。MCP だけ切る本フラグが正解。
 * 非信頼な文字起こしを渡す呼び出しなので P1-1 ハードニング（ツール無効化/env allowlist/隔離cwd）を適用する。
 *
 * @param {object} p
 * @param {string} p.stdin claude -p の標準入力へ流す文（プロンプト本文）
 * @param {string} p.cwd ジョブ専用の隔離ディレクトリ（createIsolatedCwd の出力）
 * @param {number} [p.timeoutMs] この時間を超えたら SIGTERM で止めて例外にする
 * @param {(msg:string)=>void} [p.onLog] 子プロセスの stderr を行単位で受け取る
 * @param {string[]} [p.extraArgs] 呼び出し側だけに要る追加引数（例: ["--model", "..."]）。
 *   既定は空配列＝何も足さない。守りの引数（NO_TOOLS_ARGS 等）の後ろに並べるだけで、
 *   守りを上書き・削除する用途には使わない。
 * @returns {Promise<string>} envelope.result ?? envelope.content ?? 生の stdout
 *   終了コードが 0 でなかったときの Error には、子プロセスの stderr 全文を `.stderr` で付ける
 *   （src/digest-editor.mjs が「--model が原因の失敗か」を判定するのに使う。切り詰めると
 *    判定が message の切り詰め位置に依存してしまうので、message とは別に丸ごと渡す）。
 */
export function runClaudeJson({
  stdin,
  cwd,
  timeoutMs = DEFAULT_CLAUDE_TIMEOUT_MS,
  onLog = () => {},
  extraArgs = [],
}) {
  // 打ち切り時間は必ず要る。null や 0 を渡されて「いつまでも待つ」状態になると、
  // 応答が返らないモデルで工程が永久に止まり、画面は動いているように見えたまま終わらない。
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`claude -p の打ち切り時間(timeoutMs)が不正です: ${timeoutMs}`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      ["-p", "--strict-mcp-config", "--output-format", "json", ...NO_TOOLS_ARGS, ...extraArgs],
      {
        windowsHide: true,
        env: buildSafeEnv(),
        cwd,
      }
    );

    let stdoutBuf = "";
    let stderrBuf = "";

    child.stdout.on("data", (c) => (stdoutBuf += c.toString()));
    child.stderr.on("data", (c) => {
      const line = c.toString();
      stderrBuf += line;
      onLog(`[claude stderr] ${line.trim()}`);
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude -p タイムアウト (${timeoutMs / 1000}s)`));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const err = new Error(`claude 終了コード ${code}。stderr: ${stderrBuf.slice(0, 400)}`);
        err.stderr = stderrBuf; // 呼び出し側が失敗の中身で分岐できるよう、切り詰めない全文も渡す
        return reject(err);
      }
      let envelope;
      try {
        envelope = JSON.parse(stdoutBuf.trim());
      } catch (e) {
        return reject(
          new Error(`claude stdout JSON parse 失敗: ${e.message}\nraw: ${stdoutBuf.slice(0, 400)}`)
        );
      }
      resolve(envelope.result ?? envelope.content ?? stdoutBuf);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`claude spawn エラー: ${err.message}`));
    });

    child.stdin.write(stdin, "utf-8");
    child.stdin.end();
  });
}
