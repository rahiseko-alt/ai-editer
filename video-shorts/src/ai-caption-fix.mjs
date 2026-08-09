// video-shorts AI による字幕の直し（文字起こしの変換ミスを文脈から直す工程）
//
// 【何のためか】音声認識は音は合っていても字を間違える（「公開」と「後悔」、「回答」と「解答」）。
// ※ ここに書く例は、受入判定に使う固定素材の正解表（tests/fixtures/ai-caption-fix/expected.json）に
//    出てくる語と重ねないこと。重ねると「答えを教え込んだ状態で実力を測る」ことになる
//    （2026-08-09 の independent-verifier の指摘で是正。葉 G-EDIT-CAPTION-AI-I の条件(5)）。
// 字幕は焼き込み式なので、間違ったまま焼くと作り直しになる。人が1語ずつ直す前に、
// 文脈が読める AI に「明らかな変換ミス」だけを直させて、人の手直しを減らす。
//
// 【AI に何をさせないか】ここで許すのは「既にある語の綴りの置き換え」だけである。
// 語を足す・消す・並べ替える・時刻を変えることは、モデルの返答が何を言っていても起きない。
// 返答から読むのは {index, before, after} の3つだけで、words / segments / duration のような
// 他のキーは読まずに捨てる（＝語数と時刻はモデルの手が届かない）。
// 時刻が動くと字幕が声からずれ、語数が動くと caption-store.mjs の「何番目の語」が全部ずれる。
//
// 【語だけでなく段落の文章も直す】transcript には語（words[]）とは別に段落の文章（segments[].text）が
// あり、区間選定が読むのは後者である。語だけ直すと、選定が返す keepText は誤変換のままの文字列になり、
// src/reverse-match.mjs が語の側と突き合わせても一致せず、区間がずれるか
// 「逆マッチングで確定した区間が0件」で落ちる。だから直しは両方へ当てる。
//
// 【元を残す】直す前の transcript.json は transcript.raw.json へ丸ごと退避する。
// 元が残っていないと「AI が直した結果が本当に良くなったのか」を後から確かめられず、
// 直しすぎたときに戻せない。退避は初回だけで、2回流しても最初の元が残る。
//
// 【人の直しが勝つ】画面での手直し（caption-store.mjs の caption-edits.json）は、この工程の
// 後に重ねられる。AI が直した語を人がさらに直したら、人の文字が最後に残る。
//
// CLI としても使える（本物のモデルで流す）:
//   node src/ai-caption-fix.mjs <workDir>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_WORD_LENGTH } from "./caption-store.mjs";
import { createIsolatedCwd, wrapUntrustedText } from "./claude-safety.mjs";
import { runClaudeJson } from "./claude-run.mjs";

/** AI が直した内容を置くファイル名（ジョブの作業フォルダの中） */
export const AI_FIXES_FILE = "ai-caption-fixes.json";

/** 直す前の文字起こしの退避先のファイル名 */
export const RAW_TRANSCRIPT_FILE = "transcript.raw.json";

/** 1 回の呼び出しに渡す語数の既定。長い文字起こしを1回で渡すと返答が途中で切れる。 */
export const CHUNK_WORDS = 200;

/** 1 回の呼び出しに許す時間。server/claude-select.mjs と同じ 5 分。 */
export const MODEL_TIMEOUT_MS = 300_000;

/**
 * 1 かたまり分の「変換ミスを直させる」プロンプトを組み立てる。
 *
 * 文字起こしは非信頼データなので、既存の守り wrapUntrustedText で囲む（P1-1-D）。
 * 乱数 nonce 付きのタグなので、文字起こしの中に閉じタグを書いておく細工をされても、
 * 乱数を当てられない限り境界の外へ抜け出せない。自前の固定文字列で囲むと詐称できてしまう。
 *
 * @param {{w:string,start:number,end:number}[]} words このかたまりの語
 * @param {number} offset このかたまりの先頭が、文字起こし全体で何番目の語か
 * @returns {string}
 */
export function buildFixPrompt(words, offset) {
  // 添字は文字起こし全体での実添字（offset + i）。かたまりの中の番号を渡すと、
  // 2かたまり目以降の直しが先頭の語に当たってしまう。
  const lines = words.map((w, i) => `${offset + i}\t${w.w}`).join("\n");

  return `あなたは日本語の文字起こしを校正する人です。音声認識が音は合っているのに字を間違えた所` +
    `（変換ミス・同音異義語の取り違え）だけを、前後の文脈から直してください。

# 文字起こし（1 行に 1 語で「添字<タブ>語」。添字は文字起こし全体での語の番号）
${wrapUntrustedText("TRANSCRIPT", lines)}

# できること・できないこと
- できるのは、既にある語の綴りを別の綴りへ置き換えることだけ。
- 語の追加・削除・並べ替え・時刻の変更はできない。
- 言い回しの改善・要約・敬語の統一はしない。明らかな変換ミスだけを直す。
- 迷ったら直さない。直す必要が無ければ 1 件も返さなくてよい。

# 返し方
次の JSON のみを返す（説明文・前置き・後置きは不要。コードフェンスで囲んでも構わない）。
{"fixes":[{"index":5,"before":"公開","after":"後悔"}]}
- index は上に並んだ添字をそのまま使う。同じ添字を2回以上返してはいけない
  （どちらが正しいか決められないので、その添字の直しは全部捨てる）。
- before は、その添字の語を一字一句そのまま書き写す（違っていればその1件は捨てられる）。
- after は直した後の語。1 語だけ・改行なし・${MAX_WORD_LENGTH}文字以内。
- 直す必要が無ければ {"fixes":[]} を返す。`;
}

/**
 * モデルの返答から、採用してよい直しだけを取り出す。
 *
 * 【なぜ黙って捨てるものと例外にするものを分けるか】
 * 「返答そのものが読めない（JSON でない・fixes が無い）」は工程の失敗なので例外にする。
 * 黙って 0 件にすると、モデルが一度も答えていないのに「直す所は無かった」と区別がつかない。
 * 一方「1 件ずつの中身が条件に合わない」のは想定内（モデルは間違える）なので、その1件だけ捨てる。
 *
 * 【同じ添字が2回以上来たら全部捨てる】どちらが正しいかを機械では決められない。
 * 先に来た方を採ると、モデルの並べ方しだいで結果が変わる（同じ返答でも当たり外れが出る）。
 * 直さないのは安全側（元の文字が残るだけ）なので、迷う語は触らない。
 *
 * 【そのかたまりに出していない語は直させない】プロンプトに載せた語だけが直しの対象である。
 * 範囲を全語で見ると、モデルが「そのかたまりに入っていない添字」を返したときに、
 * 見せてもいない語を書き換えられる（1かたまりの返答で文字起こし全体に手が届く）。
 * range を渡すと、採用する添字を `offset <= index < offset + length` に絞る。
 *
 * @param {string} text モデルの返答
 * @param {{w:string}[]} words 文字起こし全体の語（かたまりではなく全部）
 * @param {{offset:number,length:number}} [range] この返答で直してよい添字の範囲
 *   （＝そのかたまりに出した語）。省略時は全語（純粋関数として単体で使うとき用）。
 * @returns {{index:number,before:string,after:string}[]} 添字の昇順
 */
export function parseFixResponse(text, words, range) {
  const body = extractJsonBody(text);
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    throw new Error(
      `AIの返答をJSONとして読めませんでした: ${e.message}（返答の先頭: ${String(text ?? "").slice(0, 120)}）`
    );
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error('AIの返答が {"fixes":[...]} の形ではありません（オブジェクトではありません）');
  }
  if (!Array.isArray(data.fixes)) {
    throw new Error('AIの返答に fixes の配列がありません（直しが無いときも {"fixes":[]} を返させています）');
  }

  // 先に添字の重複を数える。2回以上出てくる添字は、その語の直しを1件も採らない。
  const seenCount = new Map();
  for (const f of data.fixes) {
    if (f === null || typeof f !== "object" || Array.isArray(f)) continue;
    if (!Number.isInteger(f.index)) continue;
    seenCount.set(f.index, (seenCount.get(f.index) ?? 0) + 1);
  }

  const all = words || [];
  // 直してよい添字の範囲。range 未指定なら全語（単体で使うとき）。
  const lo = range && Number.isInteger(range.offset) ? range.offset : 0;
  const hi = range && Number.isInteger(range.length) ? lo + range.length : all.length;
  const out = [];
  for (const f of data.fixes) {
    if (f === null || typeof f !== "object" || Array.isArray(f)) continue;
    const { index } = f;
    // 添字は整数で、実在する語を指していること（範囲外は語数を変えようとしているのと同じ）。
    if (!Number.isInteger(index) || index < 0 || index >= all.length) continue;
    // そのかたまりで見せていない語は直させない（見せていない所に手を伸ばした返答は捨てる）。
    if (index < lo || index >= hi) continue;
    if ((seenCount.get(index) ?? 0) > 1) continue; // 同じ語に2件以上＝どちらも採らない
    const src = all[index];
    if (!src || typeof src.w !== "string") continue;
    // before が実際の語と違う＝モデルが別の語を見ている。位置がずれた直しは当てない。
    if (typeof f.before !== "string" || f.before.trim() !== src.w.trim()) continue;
    if (typeof f.after !== "string") continue;
    // 改行は trim 前の生の文字で見る。trim だけだと「後悔\n」は通ってしまい、
    // 字幕(ASS)の1行に改行が混ざる。
    if (/[\r\n]/.test(f.after)) continue;
    const after = f.after.trim();
    if (after.length === 0) continue;
    // 長さの数え方は caption-store.mjs の手直しと同じ（JS の String.length ＝ UTF-16 の符号単位数）。
    // 二つの入口で数え方が違うと、片方で通る語がもう片方で弾かれる。
    if (after.length > MAX_WORD_LENGTH) continue;
    if (after === src.w) continue; // 直っていないものを直した扱いにしない
    out.push({ index, before: src.w, after });
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * 直しを語の配列へ当て込んだ新しい配列を返す。
 * 差し替えるのは w だけで、start / end には触れない（触ると字幕が声からずれる）。
 */
export function applyFixes(words, fixes) {
  const table = new Map();
  for (const f of fixes || []) {
    if (!table.has(f.index)) table.set(f.index, f.after);
  }
  return (words || []).map((w, i) => (table.has(i) ? { ...w, w: table.get(i) } : w));
}

/**
 * 直しを段落の文章（segments[].text）へも当て込んだ新しい配列を返す。
 *
 * 【なぜ要るか】区間選定が読むのは segments[].text で、選定が返す keepText はその文章からの
 * 抜き出しになる。語だけ直して文章を直さないと、選定は誤変換のままの文字列を返し、
 * src/reverse-match.mjs が語の側（直した文字）と突き合わせても一致しない。
 *
 * 【どの段落に当てるか】その語の開始時刻を含む段落。時刻で選ぶので、同じ文字が別の段落に
 * あっても取り違えない。
 *
 * 【段落の中のどこに当てるか＝その語自身の位置】段落に同じ文字が2回以上あるとき、
 * 「before の最初の1回」を置き換えると、モデルが直したのが後ろの語でも前の語が書き換わる。
 * そうなると words[] と segments[].text が食い違い、区間選定→keepText→src/reverse-match.mjs
 * を経て焼き込みへ出る文言が、直したはずの語と別物になる。
 * だから段落に属する語を順に走査して1語ずつの文字位置（オフセット）を求め、
 * その語自身の位置で置き換える。置き換えは**オフセットの降順**に当てる
 * （前から当てると、長さが変わったぶん後ろの位置がずれる）。
 *
 * 【対応が取れない段落は触らない】語をつないだものが段落の文章と辿れない素材
 * （文字起こしの取りこぼし等）では、どの位置がその語かを決められない。
 * その段落は1文字も変えない＝黙って別の箇所を書き換えない。
 *
 * @param {{start:number,end:number,text:string}[]} segments
 * @param {{index:number,before:string,after:string}[]} fixes
 * @param {{start:number,w:string}[]} words 文字起こし全体の語（直す前）
 */
export function applyFixesToSegments(segments, fixes, words) {
  const list = (segments || []).map((s) => ({ ...s }));
  const all = words || [];

  // 段落ごとに、その段落へ当てる直しを集める（1件ずつ当てると位置がずれるため）。
  const bySegment = new Map();
  for (const f of fixes || []) {
    const w = all[f.index];
    if (!w || typeof w.start !== "number") continue;
    const si = list.findIndex(
      (s) => typeof s.text === "string" && w.start >= s.start && w.start <= s.end
    );
    if (si === -1) continue;
    if (!bySegment.has(si)) bySegment.set(si, []);
    bySegment.get(si).push(f);
  }

  for (const [si, segFixes] of bySegment) {
    const seg = list[si];
    const offsets = wordOffsetsInSegment(seg, all);
    if (!offsets) continue; // 語と文章の対応が取れない＝どこを直すか決められないので触らない
    const targets = [];
    for (const f of segFixes) {
      const at = offsets.get(f.index);
      if (at === undefined) continue;
      // 求めた位置に本当にその語があるかを最後に確かめる（ずれた置き換えを当てない）。
      if (seg.text.slice(at, at + f.before.length) !== f.before) continue;
      targets.push({ at, f });
    }
    targets.sort((a, b) => b.at - a.at); // 後ろから当てる＝前の位置がずれない
    for (const { at, f } of targets) {
      seg.text = seg.text.slice(0, at) + f.after + seg.text.slice(at + f.before.length);
    }
  }
  return list;
}

/**
 * その段落に属する語（開始時刻が段落の中にある語）の、段落の文章での文字位置を返す。
 * 語は文章の中に出てくる順に並ぶ前提で、前の語の直後から次の語を探す
 * （同じ文字が複数あっても、その語自身の出現に当たる）。
 * 1語でも辿れなければ null（＝その段落は触らない）。
 *
 * @returns {Map<number,number>|null} 語の添字 → 段落の文章での開始位置
 */
function wordOffsetsInSegment(seg, words) {
  const offsets = new Map();
  let cursor = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w || typeof w.start !== "number" || typeof w.w !== "string") return null;
    if (w.start < seg.start || w.start > seg.end) continue;
    const at = seg.text.indexOf(w.w, cursor);
    if (at === -1) return null;
    offsets.set(i, at);
    cursor = at + w.w.length;
  }
  return offsets;
}

/**
 * 文字起こしを AI に読ませ、変換ミスを直して transcript.json を置き換える工程。
 *
 * @param {object} p
 * @param {string} p.workDir ジョブの作業フォルダ（transcript.json がある所）
 * @param {(promptDoc:string)=>Promise<string>} p.runModel モデルを呼ぶ関数
 * @param {number} [p.chunkWords] 1 回に渡す語数
 * @param {(s:string)=>void} [p.onLog]
 * @returns {Promise<{fixed:number,total:number,chunks:number}>}
 */
export async function aiCaptionFixStage({ workDir, runModel, chunkWords = CHUNK_WORDS, onLog }) {
  const transcriptPath = path.join(workDir, "transcript.json");
  if (!fs.existsSync(transcriptPath)) {
    throw new Error(`文字起こし(transcript.json)がありません: ${transcriptPath}`);
  }
  // 退避はここで読んだ「元の中身そのまま」を書く（parse→stringify し直すと、
  // 元のファイルと1バイトも違わないことを後から確かめられなくなる）。
  const originalText = fs.readFileSync(transcriptPath, "utf-8");
  const transcript = JSON.parse(originalText);
  const words = transcript.words || [];

  const size = Number.isInteger(chunkWords) && chunkWords > 0 ? chunkWords : CHUNK_WORDS;
  const chunks = [];
  for (let i = 0; i < words.length; i += size) {
    chunks.push({ offset: i, words: words.slice(i, i + size) });
  }

  // かたまりは順番に処理する（並列にしない）。並列にするとログが混ざって、
  // どのかたまりで何が起きたのかが読めなくなる。速さが要るようになってから並列にする。
  const collected = [];
  for (let n = 0; n < chunks.length; n++) {
    const c = chunks[n];
    // runModel / parseFixResponse の例外はそのまま上へ投げる＝工程は失敗して終わる。
    // ここで握りつぶすと「AI が一度も答えていないのに直す所は無かった」ことになる。
    const answer = await runModel(buildFixPrompt(c.words, c.offset));
    // 採用するのは、このかたまりに出した語だけ（見せていない語への直しは捨てる）。
    const got = parseFixResponse(answer, words, { offset: c.offset, length: c.words.length });
    collected.push(...got);
    if (onLog) {
      const last = c.offset + c.words.length - 1;
      onLog(`[ai-caption-fix] ${n + 1}/${chunks.length} かたまり（${c.offset}〜${last} 語目）→ ${got.length} 件`);
    }
  }

  // かたまりをまたいで同じ語への直しが来たときも、どちらが正しいか決められないので全部捨てる
  // （かたまりの中で同じ添字が2回来たときと同じ扱い）。
  const countByIndex = new Map();
  for (const f of collected) countByIndex.set(f.index, (countByIndex.get(f.index) ?? 0) + 1);
  const fixes = collected
    .filter((f) => countByIndex.get(f.index) === 1)
    .sort((a, b) => a.index - b.index);

  const next = {
    ...transcript,
    words: applyFixes(words, fixes),
    segments: applyFixesToSegments(transcript.segments, fixes, words),
  };

  // ここから書き込み。ここまでで例外が出た経路では transcript.json を1バイトも触っていない。
  // (a) 元の退避（まだ無いときだけ）→ (b) 直しの記録 → (c) 本体の置き換え、の順に行う。
  // (c) を先にやると、途中で落ちたときに「直った本体はあるが元が無い」状態になって戻せない。
  const rawPath = path.join(workDir, RAW_TRANSCRIPT_FILE);
  if (!fs.existsSync(rawPath)) {
    writeFileAtomically(rawPath, originalText);
  }
  writeFileAtomically(
    path.join(workDir, AI_FIXES_FILE),
    `${JSON.stringify({ fixes }, null, 2)}\n`
  );
  writeFileAtomically(transcriptPath, `${JSON.stringify(next, null, 2)}\n`);

  return { fixed: fixes.length, total: words.length, chunks: chunks.length };
}

/**
 * 本物のモデル（claude -p）を呼ぶ runModel。
 * 起動の守り（ツール無効化 / env allowlist / タイムアウト）は src/claude-run.mjs が持つ。
 */
export async function defaultRunModel(promptDoc, { cwd, timeoutMs = MODEL_TIMEOUT_MS }) {
  return runClaudeJson({ stdin: promptDoc, cwd, timeoutMs });
}

/**
 * 本物のモデルで工程を回すための runModel を作る。
 * cwd はジョブ専用の隔離ディレクトリ（他ジョブ・他顧客のファイルに触れない）。
 */
export function createDefaultRunModel(workDir, timeoutMs = MODEL_TIMEOUT_MS) {
  const cwd = createIsolatedCwd(path.basename(workDir));
  return (promptDoc) => defaultRunModel(promptDoc, { cwd, timeoutMs });
}

/** コードフェンスを剥がし、最初の { から最後の } までを取り出す。 */
function extractJsonBody(text) {
  const s = typeof text === "string" ? text : "";
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fence ? fence[1] : s).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  // 波括弧が見つからないときは、そのまま JSON.parse に判定を委ねて例外にする
  // （ここで空を返すと「読めない返答」が「直し0件」に化ける）。
  if (start === -1 || end === -1 || end < start) return body;
  return body.slice(start, end + 1);
}

/**
 * 同じフォルダの一時ファイルへ書いてから置き換える（caption-store.mjs と同じ作法）。
 * 直接上書きすると、書いている途中で落ちたときに中身が丸ごと読めなくなる。
 */
function writeFileAtomically(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, target);
}

// ── CLI（本物のモデルで流す） ────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [workDir] = process.argv.slice(2);
  if (!workDir) {
    console.error("usage: node src/ai-caption-fix.mjs <workDir>");
    process.exit(2);
  }
  aiCaptionFixStage({
    workDir,
    runModel: createDefaultRunModel(workDir),
    onLog: (s) => process.stderr.write(`${s}\n`),
  })
    .then((r) => console.log(`ai caption fix done: ${r.fixed} fix(es) / ${r.total} word(s) / ${r.chunks} chunk(s)`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
