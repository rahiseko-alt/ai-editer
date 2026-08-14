// server/job-params.mjs — POST /api/jobs のクエリパラメータ検証（副作用なし・単体テスト用に分離）。
// サポートする設定契約（P0-5）: UIが送りうる値のみを許可し、それ以外は既定値へフォールバックする。

const SUPPORTED_CUTS = new Set(["topic", "minutes"]);
const SUPPORTED_SIZES = new Set(["9:16", "16:9"]);

/** クエリパラメータ(URLSearchParams)を検証済みのジョブ設定へ正規化する */
export function parseJobParams(searchParams) {
  const sub = searchParams.get("sub") === "on" ? "on" : "none";
  const cutRaw = searchParams.get("cut") ?? "topic";
  const cut = SUPPORTED_CUTS.has(cutRaw) ? cutRaw : "topic";
  const sizeRaw = searchParams.get("size") ?? "9:16";
  const size = SUPPORTED_SIZES.has(sizeRaw) ? sizeRaw : "9:16";
  const cutMinRaw = Number(searchParams.get("cutMin"));
  const cutMin = Number.isFinite(cutMinRaw) && cutMinRaw >= 1 && cutMinRaw <= 60 ? cutMinRaw : 3;
  // 顔モザイク（G-EDIT-MOSAIC-UI）。既定は none＝掛けない。
  // 既定を on にしないのは、顔を隠す必要がないお客様の使い方をこれまでどおり保つため。
  const mosaic = searchParams.get("mosaic") === "on" ? "on" : "none";
  // 無音・言い淀みの詰め。既定は none＝これまでどおり詰めない。
  // 既定で詰めると、今まで通りに使っている人の成果物が黙って短くなる。
  const trim = searchParams.get("trim") === "on" ? "on" : "none";
  // つなぎ目に戻す息継ぎの間（G-EDIT-BREATH）。既定は空＝pipeline.mjs 側の既定(0.7秒)に従う。
  // 受け付けるのは "off" と 0〜5 秒の数値だけ。それ以外（負値・5超・文字列）は既定へ戻す。
  // ここで弾かずに渡すと pipeline.mjs が fail-fast して、利用者にはジョブ失敗としか見えない。
  const breathRaw = (searchParams.get("breath") ?? "").trim().toLowerCase();
  let breath = "";
  if (breathRaw === "off" || breathRaw === "none") breath = "off";
  else if (breathRaw !== "") {
    const n = Number(breathRaw);
    if (Number.isFinite(n) && n >= 0 && n <= 5) breath = String(n);
  }
  const name = searchParams.get("name") ?? "upload.mp4";
  return { sub, cut, size, cutMin, mosaic, trim, breath, name };
}
