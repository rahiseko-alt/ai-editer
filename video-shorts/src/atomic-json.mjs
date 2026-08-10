// video-shorts 状態JSON の原子的書き込み共通ヘルパー — P2-1
//
// state.json 等は、書き込み中にプロセスが強制終了すると壊れる恐れがある。
// 直接最終pathへ `fs.writeFileSync(p, ...)` する実装は内部で O_TRUNC 付きで open するため、
// open した時点でファイルが0バイトへ切り詰められる。書き終える前に落ちると、元あった
// 内容ごと失われ、以後 JSON.parse できなくなる（ジョブの進捗が読めず再開できなくなる）。
//
// caption-store.mjs の writeEditsAtomically と同じ「同じディレクトリの一時ファイルへ書く→
// rename で置き換える」作法に、fsync（tmpファイルの内容をディスクへ確定させてから rename
// する）を加えて共通化する。rename は同一ファイルシステム内であれば POSIX 上 atomic なので、
// 置き換え途中の状態が外部から観測されることはない（旧内容のまま か 新内容のまま のどちらか）。
import fs from "node:fs";
import path from "node:path";

/**
 * オブジェクトを JSON 化して同じディレクトリの一時ファイルへ書き、fsync でディスクへ
 * 確定させてから最終pathへ rename する。
 * @param {string} filePath 書き込み先の最終パス
 * @param {object} data JSON化するオブジェクト
 */
export function writeJsonAtomically(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}
