// video-shorts 区間選定モード定義。
// buildPrompt が SYSTEM_RULES_BASE + そのモードの fragment を合成する。
// keepText は全モード共通で「本文の連続抜き出し（要約禁止）」＝逆マッチ前提を崩さない。
//
// 【モードは2種あるが、プロンプトを持つのは topic だけ】
// ダイジェスト（画面の「分数で切る」）は、台本の再構成・批評→修正ループまで含む編集エージェント
// src/digest-editor.mjs が丸ごと担当する。経路も別で、
//   - server/pipeline-runner.mjs は mode==="digest" のとき runClaudeSelect を呼ばない
//   - pipeline.mjs cmdSelect は mode==="digest" のとき runDigestEditor を呼んで即 return する
// ため、このファイルの digest 用プロンプト断片は **どの経路からも AI に届かない**。
// 2026-08-17 まで、ここには digest 用の fragment が書かれていたが、上記のとおり到達不能な
// 死んだ文言だった（「あるのに効いていない」状態）。実態に合わせて fragment を持たせず、
// 「プロンプト経路では扱わないモード」であることを promptDriven:false / handledBy で明示し、
// 誤って buildPrompt へ渡されたら requirePromptMode() が担当ファイル名つきで落とす形にする。
// ＝ 文言を消しただけの放置ではなく、「digest の選定文言はここには無い」ことが機械で分かる。

export const DEFAULT_MODE = "topic";

export const MODES = {
  topic: {
    label: "話題毎",
    targetCount: 0, // 上限なし（全トピックを漏れなく）
    promptDriven: true,
    fragment: `【モード: 話題毎（全カバー・テーマ単位でまとめる）】
この動画を漏れなく全区間に分割せよ。話題が少し変わるたびに区切るのではなく、
関連する内容（同じ話題の深掘り・雑談を挟んだ続き等）はまとめて1つの区間にせよ。
1区間の長さは、下に「1本あたりの尺の条件」があれば必ずそれに従う（そこに書かれた方針が、
どこで区切るかを決める）。条件が無いときだけ、1区間は数分〜十分程度を目安にし、
細かく切りすぎない（本数を絞ることを優先する）。
冒頭の挨拶・締めの定型・機材確認や本編でない雑談だけを除外し、それ以外の本編は必ずどれかの
区間に含めよ（取りこぼし禁止＝素材を最大限使う）。各区間の keepText は最初の一文から最後の一文まで
丸ごと連続で抜き出す。`,
  },
  digest: {
    label: "ダイジェスト",
    targetCount: 0,
    // このモードの実体は src/digest-editor.mjs（理解→台本→批評→修正→尺是正）。
    // 選定プロンプトは持たない＝ここに文言を置いても届かない（ファイル冒頭の説明を参照）。
    promptDriven: false,
    handledBy: "src/digest-editor.mjs",
  },
};

/** mode 文字列から定義を取得（不正値は既定へフォールバック） */
export function getMode(mode) {
  return MODES[mode] || MODES[DEFAULT_MODE];
}

/** そのモードが select-segments のプロンプト経路で扱えるか（＝fragment を持つか）。 */
export function isPromptDrivenMode(mode) {
  return getMode(mode).promptDriven === true;
}

/**
 * プロンプト経路で扱えるモードだけを通す関門。扱えないモード（digest）は、
 * 黙って既定モードへ落ちる／中身の無いプロンプトを組み立てる、といった曖昧な失敗にせず、
 * 「担当は別ファイル」であることを名指しで伝えて落とす。
 */
export function requirePromptMode(mode) {
  const m = getMode(mode);
  if (!m.promptDriven) {
    throw new Error(
      `モード「${m.label}」は select-segments のプロンプト経路では扱いません` +
        `（担当: ${m.handledBy}）。選定プロンプトを組み立てずにそちらを呼んでください。`
    );
  }
  return m;
}

/** mode が有効か（init のヒアリング必須チェック用） */
export function isValidMode(mode) {
  return Object.prototype.hasOwnProperty.call(MODES, mode);
}
