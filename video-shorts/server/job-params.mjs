// server/job-params.mjs — POST /api/jobs のクエリパラメータ検証（副作用なし・単体テスト用に分離）。
// サポートする設定契約（P0-5）: UIが送りうる値のみを許可し、それ以外は既定値へフォールバックする。
//
// 2026-08-15 追加(G-EDIT-UI-SETTINGS-VALIDATE / G-EDIT-UI-SETTINGS-ACCEPT): 字幕スタイル一式
// (subStyle/captionFont/captionFill/captionOutlineColor/captionInner/captionBand)・尺の指示
// (durationMin)・書き出しプリセット(exportPreset)。既存のbreathと同じ方針＝不正・範囲外・欠落は
// 例外を投げず既定値(未指定扱い)へ丸める。判定はCLI側の正引き関数(getFont/getStyle/hexToAss/
// getExportPreset)へそのまま委譲し、ここに独自のバリデーションロジックを重複させない
// （getFont/getStyle は Object.hasOwn 済みで __proto__/constructor 等のプロトタイプ汚染狙いの
// キーも自前キーとして扱わない＝正引きに失敗し既定値へ丸まる）。

import {
  CAPTION_POS_MAX,
  CAPTION_POS_MIN,
  getFont,
  getStyle,
  hexToAss,
} from "../src/subtitle-styles.mjs";
import { getExportPreset } from "../src/export-presets.mjs";

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
  // 2026-08-16 マスター指示（B案）で、1つだったつまみを2つへ割った。
  //   trimSilence … 無音を詰める / trimFiller … 言い淀みを消す
  // 旧 trim=on は「両方あり」として受け続ける（CLI・既存の検査・古い画面との後方互換）。
  // ここを落とすと、旧いクエリが未知の値として "none" へ丸まり、詰め処理が一切走らないまま
  // 「間が残っている」系の検査が緑になる（偽の緑）。
  const legacyTrimOn = searchParams.get("trim") === "on";
  const hasNew = searchParams.has("trimSilence") || searchParams.has("trimFiller");
  const onOr = (key) =>
    hasNew ? (searchParams.get(key) === "on" ? "on" : "none") : legacyTrimOn ? "on" : "none";
  const trimSilence = onOr("trimSilence");
  const trimFiller = onOr("trimFiller");
  // 既存の呼び出し元（pipeline-runner の resolveJobSettings 等）が見る総合フラグ。
  // どちらか一方でも「あり」なら詰め工程を走らせる。
  const trim = trimSilence === "on" || trimFiller === "on" ? "on" : "none";
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

  // 字幕スタイル名（G-EDIT-UI-SETTINGS-*）。既定は空＝pipeline.mjs 側の既定(karaoke)に従う。
  // 未指定なら server/pipeline-runner.mjs 側で --sub-style を一切付けない、という breath と
  // 同じパターンにするため、DEFAULT_SUBTITLE_STYLE を明示的には返さない。
  const subStyleRaw = searchParams.get("subStyle") ?? "";
  const subStyle = getStyle(subStyleRaw) ? subStyleRaw : "";

  // 字幕の書体キー。既定は空＝未指定扱い(pipeline.mjs 側が既定書体kakuを解決する)。
  const captionFontRaw = searchParams.get("captionFont") ?? "";
  const captionFont = getFont(captionFontRaw) ? captionFontRaw : "";

  // 字幕の文字色／外側縁取り色。"#RRGGBB" or "#RRGGBBAA" 以外は既定(空=未指定)へ丸める。
  const captionFillRaw = searchParams.get("captionFill") ?? "";
  const captionFill = hexToAss(captionFillRaw) !== null ? captionFillRaw : "";
  const captionOutlineColorRaw = searchParams.get("captionOutlineColor") ?? "";
  const captionOutlineColor = hexToAss(captionOutlineColorRaw) !== null ? captionOutlineColorRaw : "";

  // 内側縁取り／背景帯の色。"off"はそのまま無効化として通す（pipeline.mjs 281行付近と同じ扱い）。
  // それ以外は色形式として妥当なときだけ通し、そうでなければ未指定(空)へ丸める。
  const captionInnerRaw = searchParams.get("captionInner") ?? "";
  const captionInner =
    captionInnerRaw === "off" ? "off" : hexToAss(captionInnerRaw) !== null ? captionInnerRaw : "";
  const captionBandRaw = searchParams.get("captionBand") ?? "";
  const captionBand =
    captionBandRaw === "off" ? "off" : hexToAss(captionBandRaw) !== null ? captionBandRaw : "";

  // 字幕の縦位置（G-UI-CAPPOS。画面のプレビュー上でつまみを動かして決める）。単位は
  // 「画面の高さに対する％」で 0=一番下。未指定は undefined＝スタイルの既定位置に従う。
  // 0 も正当な指定なので、真偽ではなく「有限数か・範囲内か」で判定する。
  const captionPosRaw = (searchParams.get("captionPos") ?? "").trim();
  const captionPosNum = Number(captionPosRaw);
  const captionPos =
    captionPosRaw !== "" &&
    Number.isFinite(captionPosNum) &&
    captionPosNum >= CAPTION_POS_MIN &&
    captionPosNum <= CAPTION_POS_MAX
      ? captionPosNum
      : undefined;

  // 書き出しプリセット名。既定は空＝未指定扱い(pipeline.mjs 側の既定standardに従う)。
  const exportPresetRaw = searchParams.get("exportPreset") ?? "";
  const exportPreset = getExportPreset(exportPresetRaw) ? exportPresetRaw : "";

  // 尺の指示(topicモードのみ有効。digestモードではpipeline.mjs側が無視する)。
  // サーバ側では「正の有限数かどうか」だけを見る（具体的な上下限はpipeline.mjs側のバリデーション）。
  const durationMinRaw = Number(searchParams.get("durationMin"));
  const durationMin = Number.isFinite(durationMinRaw) && durationMinRaw > 0 ? durationMinRaw : undefined;

  return {
    sub,
    cut,
    size,
    cutMin,
    mosaic,
    trim,
    trimSilence,
    trimFiller,
    breath,
    name,
    subStyle,
    captionFont,
    captionFill,
    captionOutlineColor,
    captionInner,
    captionBand,
    captionPos,
    exportPreset,
    durationMin,
  };
}
