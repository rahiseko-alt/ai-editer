// ヘルスチェック用エンドポイント（G-4-1 の監視決定=Vercelログ＋ヘルスチェックを裏打ち）。
// 200 + {"status":"ok"} を返すだけの軽量ルート。外形監視やスモークから叩く。
export function GET() {
  return Response.json({ status: "ok" }, { status: 200 });
}
