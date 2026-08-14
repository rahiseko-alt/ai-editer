// video-shorts 書き出しプリセット — 一般的な編集ソフトの「書き出し設定」に相当する選択式。
//
// 背景（2026-08-14 実素材の初回処理・docs/failures.md）：
// 書き出しは `-crf 20` 固定で、利用者が選ぶ口が無かった。その結果 7分10秒の縦型が
// 70.4MB になり「SNSにもメール添付にも大きい」状態のまま渡すしかなかった。
// 用途（どこへ出すか）が決まれば適した設定はほぼ決まるので、用途で選べるようにする。
//
// 設計方針:
//   - 用途プリセットを選ぶ（youtube / sns / x / archive / light）か、個別指定する。
//   - 個別指定は、プリセットの上から1項目ずつ上書きできる（全部書かなくてよい）。
//   - 触るのは「圧縮の強さ・コーデック・音声ビットレート」だけに絞る。解像度・fps・
//     色空間は既存の経路（orientation / 拡大ガード / BT.709固定）が正で、ここでは変えない。
//     ＝この表を足したせいで既存の受入事実（縦型になる・色が壊れない）が動かないようにする。
//
// 数値の根拠（2026-08-14 調査。出典は下記）:
//   - YouTube 1080p の推奨ビットレートは 8〜12Mbps、4K(H.265)は 35〜45Mbps。
//   - MP4(H.264)+AAC が最も汎用で、SNS投稿・共有に向く。
//   - H.265(HEVC) は同画質でファイルが小さいが、再生互換は H.264 に劣る。
//   出典: https://omniweb.jp/m54/ , https://studio-us.org/community-blog/blog/video-export-settings/ ,
//         https://furwa.co.jp/specialty/video-file-settings/

/**
 * @typedef {object} ExportSettings
 * @property {string} vcodec   映像コーデック（ffmpeg の -c:v）
 * @property {string} preset   エンコード速度/圧縮率（-preset）
 * @property {number} crf      画質（小さいほど高画質・大きいほど軽い）
 * @property {string} acodec   音声コーデック（-c:a）
 * @property {string} abitrate 音声ビットレート（-b:a）
 */

export const EXPORT_PRESETS = {
  youtube: {
    label: "YouTube向け",
    description: "YouTubeへ上げる前提の高画質。再エンコードされる分の余裕を持たせる",
    vcodec: "libx264",
    preset: "medium",
    crf: 18,
    acodec: "aac",
    abitrate: "192k",
  },
  sns: {
    label: "SNS向け（Instagram / TikTok）",
    description: "画質と大きさのつり合い重視。縦型でそのまま投稿できる",
    vcodec: "libx264",
    preset: "veryfast",
    crf: 23,
    acodec: "aac",
    abitrate: "128k",
  },
  x: {
    label: "X（旧Twitter）向け",
    description: "Xの上限に収まりやすいよう強めに圧縮する",
    vcodec: "libx264",
    preset: "veryfast",
    crf: 26,
    acodec: "aac",
    abitrate: "128k",
  },
  archive: {
    label: "高画質で保存",
    description: "手元に原版として残す用途。綺麗だがファイルは大きい",
    vcodec: "libx264",
    preset: "slow",
    crf: 16,
    acodec: "aac",
    abitrate: "256k",
  },
  light: {
    label: "軽くして共有",
    description: "メール添付やチャット共有向け。画質より小ささを優先する",
    vcodec: "libx264",
    preset: "veryfast",
    crf: 30,
    acodec: "aac",
    abitrate: "96k",
  },
};

/** 何も選ばなかったときの既定。従来の書き出し（crf 20 / aac 192k）と同じ値にする＝既存の出力を変えない。 */
export const DEFAULT_EXPORT = "standard";

/** 従来どおりの書き出し。既定を変えると過去の成果物と見た目・大きさが変わるため、別項目として残す。 */
EXPORT_PRESETS[DEFAULT_EXPORT] = {
  label: "標準（従来どおり）",
  description: "これまでと同じ書き出し設定。指定しなければこれになる",
  vcodec: "libx264",
  preset: "veryfast",
  crf: 20,
  acodec: "aac",
  abitrate: "192k",
};

/** プリセット名の正引き。未知なら null（呼出側で一覧を出してエラーにする）。 */
export function getExportPreset(name) {
  if (typeof name !== "string" || name === "") return null;
  return Object.prototype.hasOwnProperty.call(EXPORT_PRESETS, name)
    ? EXPORT_PRESETS[name]
    : null;
}

/** CLI / UI のヘルプ用：選択肢の一覧。 */
export function listExportPresets() {
  return Object.entries(EXPORT_PRESETS).map(([key, v]) => ({
    key,
    label: v.label,
    description: v.description,
  }));
}

/**
 * プリセットに個別指定を重ねて、実際に使う書き出し設定を決める。
 *
 * 個別指定（overrides）は「指定された項目だけ」を上書きする。全部書かなくてよいのは、
 * 一般的な編集ソフトが「プリセットを選んでから1項目だけ触る」使い方をさせるのに合わせるため。
 * 読めない値・範囲外は黙って採用せず既定側を残す（黙って壊れた設定で焼くのを防ぐ）。
 *
 * @param {string} presetName プリセット名（未知なら null を返す）
 * @param {Partial<ExportSettings>} [overrides] 個別指定
 * @returns {ExportSettings|null}
 */
export function resolveExportSettings(presetName, overrides = {}) {
  const base = getExportPreset(presetName ?? DEFAULT_EXPORT);
  if (!base) return null;
  const out = {
    vcodec: base.vcodec,
    preset: base.preset,
    crf: base.crf,
    acodec: base.acodec,
    abitrate: base.abitrate,
  };
  const o = overrides || {};
  if (typeof o.vcodec === "string" && o.vcodec !== "") out.vcodec = o.vcodec;
  if (typeof o.preset === "string" && o.preset !== "") out.preset = o.preset;
  if (o.crf !== undefined && o.crf !== null && o.crf !== "") {
    const n = Number(o.crf);
    // x264 の crf は 0〜51。範囲外は採用しない（0=無劣化・51=極端に汚い）。
    if (Number.isFinite(n) && n >= 0 && n <= 51) out.crf = n;
  }
  if (typeof o.acodec === "string" && o.acodec !== "") out.acodec = o.acodec;
  if (typeof o.abitrate === "string" && o.abitrate !== "") out.abitrate = o.abitrate;
  return out;
}

/**
 * 書き出し設定を ffmpeg の引数列へ変換する。
 * 解像度・fps・色空間はここでは触らない（既存の経路が正）。
 * @param {ExportSettings} s
 * @returns {string[]}
 */
export function exportArgs(s) {
  return [
    "-c:v", s.vcodec,
    "-preset", s.preset,
    "-crf", String(s.crf),
    "-c:a", s.acodec,
    "-b:a", s.abitrate,
  ];
}
