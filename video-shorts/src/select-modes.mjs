// video-shorts 区間選定モード定義（話題毎 / ダイジェスト の2種）。
// buildPrompt が SYSTEM_RULES_BASE + 各モードの fragment を合成する。
// keepText は全モード共通で「本文の連続抜き出し（要約禁止）」＝逆マッチ前提を崩さない。
// ダイジェストの台本再構成・検証修正ループは digest-editor.mjs が担う（本ファイルは選定文言のみ）。

export const DEFAULT_MODE = "topic";

export const MODES = {
  topic: {
    label: "話題毎",
    targetCount: 0, // 上限なし（全トピックを漏れなく）
    fragment: `【モード: 話題毎（全カバー・大きなテーマ単位でまとめる）】
この動画を「大きなテーマ単位」で漏れなく全区間に分割せよ。話題が少し変わるたびに区切るのではなく、
関連する内容（同じ話題の深掘り・雑談を挟んだ続き等）はまとめて1つの区間にせよ。
目安として1区間は数分〜十分程度を基本とし、細かく切りすぎない（本数を絞ることを優先する）。
冒頭の挨拶・締めの定型・機材確認や本編でない雑談だけを除外し、それ以外の本編は必ずどれかの
区間に含めよ（取りこぼし禁止＝素材を最大限使う）。各区間の keepText は最初の一文から最後の一文まで
丸ごと連続で抜き出す。区間数の上限はないが、細分化は避け大きくまとめることを優先する。`,
  },
  digest: {
    label: "ダイジェスト",
    targetCount: 0, // AI 判断・尺自由
    fragment: `【モード: ダイジェスト（面白い所だけ・連結前提）】
この動画から最も面白い・価値が高い・引きの強い箇所だけを複数、連続抜粋せよ
（全カバーは不要）。各抜粋は本文の連続した抜き出しにする。これらは時系列に
1本のダイジェスト動画へ連結される前提なので、冗長な繰り返し・定型挨拶・間延びは捨て、
単体でも通じる密度の高い区間を選ぶ。全体の尺は内容に応じて自由に決めてよい。`,
  },
};

/** mode 文字列から定義を取得（不正値は既定へフォールバック） */
export function getMode(mode) {
  return MODES[mode] || MODES[DEFAULT_MODE];
}

/** mode が有効か（init のヒアリング必須チェック用） */
export function isValidMode(mode) {
  return Object.prototype.hasOwnProperty.call(MODES, mode);
}
