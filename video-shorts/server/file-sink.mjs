// server/file-sink.mjs — multipart のファイルパートをディスクへストリーム書き込みする sink。

import fs from "node:fs";

/**
 * fs.createWriteStream をラップし、multipart.mjs の onFile が要求する
 * { write, end, abort } インターフェースへ揃える。
 * 書き込み中にエラーが起きてもプロセスをクラッシュさせない（'error' を必ず拾う）。
 *
 * 重要: ストリームの 'error' は非同期に（open のタイミング等で遅れて）発生しうる。
 * 呼び出し側が end() 直後に hadError() を見ても、まだ 'error' が発火していないことがある
 * （Windowsのパス長上限超過などが典型例）。そのため waitClose() で 'close'（正常終了時の
 * 'finish' 後、またはエラーによる自動 destroy 後のどちらでも必ず発火する）を待てるようにする。
 * 呼び出し側は必ず waitClose() を await してから hadError() を判定すること。
 */
export function createFileSink(filePath) {
  const stream = fs.createWriteStream(filePath);
  let error = null;
  let bytesWritten = 0;
  let closed = false;
  let resolveClosed;
  const closedPromise = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  function markClosed() {
    if (closed) return;
    closed = true;
    resolveClosed();
  }

  stream.on("error", (err) => {
    error = err;
  });
  stream.on("close", markClosed);

  return {
    write(chunk) {
      if (error) return;
      bytesWritten += chunk.length;
      stream.write(chunk);
    },
    end() {
      if (error) return;
      stream.end();
    },
    abort() {
      try {
        stream.destroy();
      } catch (_err) {
        // ベストエフォート
      }
      try {
        fs.unlinkSync(filePath);
      } catch (_err) {
        // ベストエフォート（存在しない/削除できない場合は無視）
      }
    },
    hadError() {
      return error !== null;
    },
    bytesWritten() {
      return bytesWritten;
    },
    /**
     * ストリームが実際に閉じる（正常終了 or エラーによる破棄）まで待つ。
     * これを待たずに hadError() を見ると、非同期に起きるエラーの検知が間に合わないことがある。
     */
    waitClose() {
      return closedPromise;
    },
  };
}
