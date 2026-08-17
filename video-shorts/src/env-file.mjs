// src/env-file.mjs — .env ファイルから値を読む唯一の場所（SEC-ENV-REDACT）
//
// 【なぜ要るか】server/pipeline-runner.mjs の groqKeyAvailable() は「鍵が .env にしかない」
// 運用（サーバ起動後に .env を置く・env に直接は渡さない）を正規の運用として前提していたが、
// secretsToRedact()（同ファイル）は process.env しか見ていなかった。つまり .env にしか鍵が
// 無い正規の運用のとき、失敗時の SSE 配信と state.json の両方へ生の鍵が出ていた
// （2026-08-16 外部レビュー指摘・実物で確認済み）。
//
// このファイルは「.env を読んで値を取り出す」処理を1箇所に統合する。JS 側の .env パースは
// これまで groqKeyAvailable() のインライン実装（真偽しか返さない）だけだったので、統合しても
// 重複数は増えない（1→1）。
//
// 【VS_ENV_FILE】環境変数 VS_ENV_FILE を指定すると、既定の video-shorts/.env の代わりに
// そのパスを読む。テストが実運用の .env を汚さずに検証するための差し替え口。呼び出し時に
// 毎回解決する（モジュール読み込み時に固定しない）ので、import 順を気にしなくてよい。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // video-shorts/

/** 読みに行く .env のパス。VS_ENV_FILE があればそれを優先する（呼び出し時に毎回解決）。 */
export function envFilePath() {
  const override = process.env.VS_ENV_FILE;
  return override ? path.resolve(override) : path.join(ROOT, ".env");
}

/**
 * .env から指定した key の値を読む。無い・読めない・空値ならは null。
 * 鍵の運用ドキュメント通り、優先順位（env→.envの順）はここでは扱わない
 * （呼び出し側が必要に応じて process.env と組み合わせる）。
 */
export function readEnvFileValue(key) {
  try {
    const p = envFilePath();
    if (!fs.existsSync(p)) return null;
    const prefix = `${key}=`;
    // 【BOM は対応済み・追加の処理は不要】外部レビュー（CodeRabbit・PR #133）から
    // 「BOM 付き .env を読み損なう。Python 側は utf-8-sig で読むので鍵が伏字化されない」
    // という指摘が出たが、2026-08-17 に実測したところ**再現しない**。
    // 下の `line.trim()` が BOM を落とすため（ECMAScript は U+FEFF を空白に分類する）。
    // 実測: BOM 付き .env から readEnvFileValue("GROQ_API_KEY") が "gsk_..." を返す。
    // 直す前の実装を再現した対照でも同じく読めた。BOM 剥がしを足しても挙動は変わらない。
    for (const line of fs.readFileSync(p, "utf-8").split(/\r?\n/)) {
      const s = line.trim();
      if (!s.startsWith(prefix)) continue;
      const v = s.slice(prefix.length).trim().replace(/^["']|["']$/g, "");
      if (v.length > 0) return v;
    }
    return null;
  } catch (_) {
    return null;
  }
}
