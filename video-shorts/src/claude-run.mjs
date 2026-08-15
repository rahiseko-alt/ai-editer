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

/** 打ち切り(SIGTERM)のあと、まだ生きている子を強制終了(SIGKILL)するまでの猶予。 */
export const SIGKILL_GRACE_MS = 5_000;

/**
 * 失敗時の stdout から「人間が読むべき理由」を取り出して1行にする。
 *
 * claude -p --output-format json の失敗は、stdout へ JSON エンベロープで返る。理由の本文は
 * result（無ければ error / message）に入るが、これは usage や session_id など機械向けの数値の
 * **後ろ**に置かれるため、生の JSON を頭から切り詰めると理由だけが落ちる。実機(Windows)で
 * 実際にこれが起き、`{"is_error":true,...,"usage":{...` までしか出ずに原因が読めなかった。
 * 読めるときは理由を先に立て、読めないときだけ生の文字列にフォールバックする。
 *
 * @param {string} stdout 子プロセスの stdout 全文
 * @param {number} [limit] 1フィールドあたりの最大文字数
 * @returns {string}
 */
export function summarizeStdoutFailure(stdout, limit = 600) {
  const raw = String(stdout ?? "").trim();
  if (!raw) return "";
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return raw.slice(0, limit); // JSON でなければ素の出力をそのまま（切り詰めて）見せる
  }
  if (!envelope || typeof envelope !== "object") return raw.slice(0, limit);
  // 理由が入りうるフィールドを、人間可読な順に拾う。
  for (const key of ["result", "error", "message", "terminal_reason", "stop_reason"]) {
    const v = envelope[key];
    if (typeof v === "string" && v.trim()) return `${key}=${v.trim().slice(0, limit)}`;
  }
  return raw.slice(0, limit); // 既知のフィールドが無ければ生のまま
}

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
  // 作業場所も必ず要る。省略すると spawn は親の作業場所を継ぐので、隔離 cwd（P1-1-C）が
  // 黙って消え、子が上方探索でリポジトリのファイルへ手が届く状態になる。
  // 打ち切り時間と同じく、渡し忘れを実行時に落として気づけるようにする。
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new Error(`claude -p の作業場所(cwd)が不正です: ${cwd}`);
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

    // 受け取りは必ず文字列で行う（リスナを付ける前に決める）。データごとに toString() すると、
    // 日本語のような多バイト文字が2つのデータに割れたとき、それぞれが単独で復号されて
    // U+FFFD（�）に化ける。返答は日本語の JSON なので、JSON.parse が落ちるか、
    // 化けた文字がそのまま字幕へ焼き込まれる。setEncoding なら割れても繋いで復号する。
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");

    child.stdout.on("data", (c) => (stdoutBuf += c));
    child.stderr.on("data", (c) => {
      stderrBuf += c;
      onLog(`[claude stderr] ${String(c).trim()}`);
    });

    // 打ち切ったのに SIGTERM を無視する子は、そのまま残って CPU とメモリを持ち続ける。
    // 猶予のあと SIGKILL で確実に落とす。unref() してあるので、この保険が
    // Node の終了を引き延ばすことはない（正常終了時は close で解除する）。
    let killTimer = null;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS);
      killTimer.unref();
      reject(new Error(`claude -p タイムアウト (${timeoutMs / 1000}s)`));
    }, timeoutMs);
    const clearTimers = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };

    child.on("close", (code) => {
      clearTimers();
      if (code !== 0) {
        // 失敗の理由は stderr だけに出るとは限らない。claude は「起動前の失敗」(不正なフラグ等)を
        // stderr へ出す一方、「実行中の失敗」(認証が見つからない等)は結果として stdout へ出す
        // （公式ドキュメント "Run Claude Code programmatically"）。旧実装は stdout を読まずに
        // 捨てていたため、Windows実機で認証に到達できず落ちたとき、画面には
        // 「claude 終了コード 1。stderr: 」とだけ出て真因が一切分からなかった
        // （docs/failures.md 2026-08-15）。両方を報告に含める。
        //
        // stdout は --output-format json のため JSON エンベロープで返る。人間が読むべき理由は
        // その result フィールドに入っているが、これは **JSON の末尾寄りに置かれる**ため、
        // 頭から切り詰めると理由だけがちょうど落ちる（実機で発生: is_error や usage の数値だけが
        // 表示され、result に到達する前に400文字で切れた）。読めるときは result を先に立てる。
        const parts = [];
        if (stderrBuf.trim()) parts.push(`stderr: ${stderrBuf.slice(0, 400)}`);
        if (stdoutBuf.trim()) {
          parts.push(`stdout: ${summarizeStdoutFailure(stdoutBuf)}`);
        }
        if (parts.length === 0) parts.push("stderr/stdout とも空でした");
        const err = new Error(`claude 終了コード ${code}。${parts.join(" / ")}`);
        err.stderr = stderrBuf; // 呼び出し側が失敗の中身で分岐できるよう、切り詰めない全文も渡す
        err.stdout = stdoutBuf; // 同上（真因がこちらに出る経路があるため stderr と対で渡す）
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
      clearTimers();
      reject(new Error(`claude spawn エラー: ${err.message}`));
    });

    // 子がプロンプトを読み切る前に終了すると、この書き込みは EPIPE で失敗する。
    // 受け手が居ないと Promise の外の「処理されない例外」になり、サーバごと落ちる
    // （1ジョブの失敗で全ジョブが道連れになる）。ここで受けてログに残すだけに留め、
    // 呼び出し側へ返す成否は終了コード側の判定（close ハンドラ）に任せる。
    // ＝書き込みに失敗しても、失敗の理由は子の終了コード/stderr として1本で報告される。
    child.stdin.on("error", (err) => {
      onLog(`[claude stdin] 書き込みに失敗しました（子が先に終了した可能性）: ${err.message}`);
    });

    child.stdin.write(stdin, "utf-8");
    child.stdin.end();
  });
}
