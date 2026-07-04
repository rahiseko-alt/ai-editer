// video-shorts [5] 字幕スタイル登録 — 選択式プリセット。
// エフェクト(apply-effect.mjs)と同じ「プリセット選択」流儀。
// 将来の Web UI の「字幕スタイル」ドロップダウンも、この登録表をそのまま読む（単一正本）。
//
// 色は ASS 形式 &HAABBGGRR（例: 白=&H00FFFFFF / 黄=&H0000FFFF）。
// mode が描画方式を決める:
//   "karaoke" 行は出っぱなし＋現在の単語だけ highlight 色（Reels/TikTok 定番）
//   "pop"     1単語だけ画面中央に大きく、出ては消える（勢い重視）
//   "line"    行単位でまとめて表示（現状互換・安定）

export const SUBTITLE_STYLES = {
  karaoke: {
    label: "ワードハイライト",
    description: "行は白で出っぱなし、今読んでいる単語だけ黄色（Reels/TikTok定番）",
    mode: "karaoke",
    fontSize: 84,
    base: "&H00FFFFFF", // 未到達の単語（白）
    highlight: "&H0000FFFF", // 現在読んでいる単語（黄）
    outline: 9,
    shadow: 4,
    marginV: 360, // 画面下からの余白
  },
  pop: {
    label: "1語ずつポップ",
    description: "1単語だけ画面中央に大きく、出ては消える（勢い重視）",
    mode: "pop",
    fontSize: 120,
    base: "&H00FFFFFF",
    highlight: "&H0000FFFF",
    outline: 12,
    shadow: 6,
    marginV: 0, // 中央表示
  },
  bold: {
    label: "太字ライン",
    description: "行単位の白・太字・黒縁（最小変更・安定）",
    mode: "line",
    fontSize: 88,
    base: "&H00FFFFFF",
    highlight: "&H0000FFFF",
    outline: 10,
    shadow: 5,
    marginV: 400,
  },
};

export const DEFAULT_SUBTITLE_STYLE = "karaoke";

/** スタイル名の正引き。未知なら null（呼出側で利用可能一覧を提示してエラーにする） */
export function getStyle(name) {
  return SUBTITLE_STYLES[name] || null;
}

/** Web UI / CLI ヘルプ用：選択肢の一覧（key・label・description） */
export function listStyles() {
  return Object.entries(SUBTITLE_STYLES).map(([key, v]) => ({
    key,
    label: v.label,
    description: v.description,
  }));
}
