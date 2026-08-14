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
    // 縁取り・影を強化（2026-08-14「字幕がしょぼい」の指摘を受けて）。旧値(outline9/shadow4)は
    // fontSize比で細く、背景によっては輪郭が薄く見えた。Premiere Proの既定キャプション
    // スタイル(太めのストローク＋視認できる影)に近づける。
    outline: 14,
    shadow: 8,
    marginV: 360, // 画面下からの余白（固定値。区間の行数が変わってもこの値は動かない）
  },
  pop: {
    label: "1語ずつポップ",
    description: "1単語だけ画面中央に大きく、出ては消える（勢い重視）",
    mode: "pop",
    fontSize: 120,
    base: "&H00FFFFFF",
    highlight: "&H0000FFFF",
    outline: 16,
    shadow: 9,
    marginV: 0, // 中央表示
  },
  bold: {
    label: "太字ライン",
    description: "行単位の白・太字・黒縁（最小変更・安定）",
    mode: "line",
    fontSize: 88,
    base: "&H00FFFFFF",
    highlight: "&H0000FFFF",
    outline: 13,
    shadow: 7,
    marginV: 400,
  },
};

export const DEFAULT_SUBTITLE_STYLE = "karaoke";

/**
 * 字幕スタイルの設計基準解像度（AUD-P2-22）。
 * 上の SUBTITLE_STYLES の fontSize/outline/shadow/marginV（絶対px値）は、この解像度で
 * 見て自然な大きさになるよう決めてある。実際の出力canvasがこれより小さい場合
 * （render-vertical.mjs の拡大ガードで縮小された場合等）、そのままの絶対値を焼くと
 * 相対的に大きすぎて長い単語が画面の左右端からはみ出す。computeSubtitleScale/scaleToken で
 * 実canvas寸法に比例縮小してから使う。
 */
export const REFERENCE_CANVAS = {
  portrait: { width: 1080, height: 1920 },
  landscape: { width: 1920, height: 1080 },
};

/**
 * 実際の出力canvas寸法に対する、字幕トークンの縮小率を求める。
 *
 * canvas が基準どおり（拡大ガードが効いていない通常サイズ＝1080x1920 or 1920x1080）なら
 * scale=1（無変化・従来どおりの見た目を維持）。canvas がそれより小さい場合だけ、
 * その比率ぶん縮小する。向きは canvas の縦横比から判定する（h>=w なら縦=portrait基準、
 * それ以外は横=landscape基準）。幅・高さ両方の比の小さいほう（min）を取るのは、
 * どちらの軸で見てもトークンが canvas をはみ出さないようにするため。
 */
export function computeSubtitleScale(canvasW, canvasH) {
  if (!(canvasW > 0) || !(canvasH > 0)) return 1;
  const ref = canvasH >= canvasW ? REFERENCE_CANVAS.portrait : REFERENCE_CANVAS.landscape;
  const scale = Math.min(canvasW / ref.width, canvasH / ref.height);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** 数値トークン(px)を scale 倍し、整数へ丸める。0 にはしない（完全に消えるのを防ぐ）。 */
export function scaleToken(n, scale) {
  return Math.max(1, Math.round(n * scale));
}

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
