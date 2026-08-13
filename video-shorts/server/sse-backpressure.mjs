// server/sse-backpressure.mjs — SSE購読者のbackpressureを尊重するpush関数 (AUD-P2-25)
//
// res.write()は書き込みを受理できなかった(=OS送信バッファが埋まっている)ときfalseを返す。
// 旧実装(server/index.mjsのhandleJobEvents)はこの戻り値を一切見ておらず、子プロセスの
// 出力行1つ1つを毎回無条件でres.write()していた。受信の遅い購読者(低速回線・タブが
// バックグラウンドで描画が止まっている等)がいると、そのHTTPレスポンスの内部バッファへ
// 際限なく書き込みが溜まり続け(res.write()はソケットへ実際に送れなくても内部的に
// キューへ積むだけで例外にならない)、購読者数×溜まった量ぶんサーバープロセス全体の
// メモリが膨らむ(監査指摘)。
//
// 対策: write()がfalseを返した(backpressure発生)ら、drainイベントが来るまで以後の
// push()呼び出しをOSへの実書き込みへ回さず、bounded ring buffer(既定200行)へ溜める。
// 上限を超えたら古い行から捨てる(coalesce)。「無制限に溜め込む」問題を「多少の進捗ログが
// 欠けることがある」に置き換える判断(止まったまま伸び続ける方が実害が大きいため)。
//
// server/index.mjsから分離しているのは、server/index.mjsをそのままimportすると
// server.listen()が副作用として実行されテスト用に実ポートを掴んでしまうため
// (server/security.mjs・server/job-lifecycle.mjsと同じ理由で、副作用の無いモジュールに
// 切り出して単体テスト可能にする)。

/** 1接続あたり、drain待ちの間だけ保持する行数の上限(既定・呼び出し側で上書き可)。 */
export const DEFAULT_BACKPRESSURE_BUFFER_LINES = 200;

/**
 * res.write()の戻り値(backpressure)を尊重するpush関数を作る。
 *
 * @param {{ write: (line: string) => boolean, on: (event: string, cb: () => void) => void }} res
 *   node:http の ServerResponse 相当(write/onだけを使う。テストでは同じ形の偽オブジェクトを渡せる)。
 * @param {{ maxBufferedLines?: number }} [opts]
 * @returns {(line: string) => void} subscribeJob() へ渡すpush関数
 */
export function createBackpressureAwarePush(res, { maxBufferedLines = DEFAULT_BACKPRESSURE_BUFFER_LINES } = {}) {
  let paused = false;
  const buffer = [];

  function flush() {
    while (buffer.length > 0) {
      const line = buffer[0];
      const ok = res.write(line);
      buffer.shift();
      if (!ok) {
        paused = true;
        return;
      }
    }
    paused = false;
  }

  res.on("drain", flush);

  function push(line) {
    if (paused) {
      // drain待ちの間はOSへ書き込まず、bounded ring bufferへ溜める。
      buffer.push(line);
      if (buffer.length > maxBufferedLines) {
        buffer.shift(); // 古い行から捨てる(無制限に伸ばさない)
      }
      return;
    }
    const ok = res.write(line);
    if (!ok) paused = true; // 次のdrainイベントまで、以後の書き込みをバッファへ回す
  }

  // テスト用に内部状態を覗けるようにする(本体の挙動には使わない)。
  push.bufferedLineCount = () => buffer.length;
  push.isPaused = () => paused;

  return push;
}
