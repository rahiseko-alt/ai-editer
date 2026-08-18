// video-shorts [固定手順] .runtime/chat-inbox.jsonl の1ジョブを、実際に編集して
// .runtime/outputs/<jobId>/result.mp4 へ書き出し、.runtime/results.jsonl へ完了を記録する。
//
// 2026-08-18 マスター指示「時間がかかりすぎ。Groqを使え。手順を固定しろ」を受けて、
// 手作業のbashコマンド往復（文字起こし→無音実測→区間選定→切り出し→字幕→焼き込み）を
// 1本のコマンドに固定した。
//
// 使い方: node src/edit-job.mjs <jobId>
//
// 手順（固定・この順で必ず実行する）:
//   1. 文字起こし（transcribe.py --backend auto。GROQ_API_KEY があれば自動でGroqを使う）
//   2. 無音区間の実測（ffmpeg silencedetect）
//   3. 区間選定（claude -p / Opus5固定。虎の巻の要点をプロンプトに埋め込み、
//      文字起こしの「セグメント番号」だけを選ばせる＝時刻を捏造させない）
//   4. 選ばれたセグメントの前後端を、実測した無音の内側へスナップ
//   5. 切り出し・結合（短いクロスフェード付き）
//   6. 縦型変換（settings.aspect==="portrait" のときのみ。reframe.py で顔追跡クロップ／
//      letterbox に自動切替。2026-08-18 発覚: 以前はこの工程が丸ごと無く、
//      「縦」を指定しても素材のネイティブ比率のまま出力されていた）
//   7. 字幕（caption:true のときのみ。語の間の無音でのみ改行し、単語の途中では絶対に割らない。
//      素材に焼き込み済みの字幕を隠す不透明帯を敷いてから焼く。PlayResX/Y・帯の座標は
//      実際の映像サイズから動的に算出する＝縦型変換後の実寸に追従する）
//   8. 出力・完了記録

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runClaudeJson } from "./claude-run.mjs";
import { wordsInRange, assTime } from "./srt-builder.mjs";
import { FONTS_DIR, FONT_CATALOG } from "./subtitle-styles.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const VIDEO_SHORTS_DIR = path.resolve(__dirname, "..");
const RUNTIME_DIR = path.join(REPO_ROOT, ".runtime");
const CHAT_INBOX = path.join(RUNTIME_DIR, "chat-inbox.jsonl");
const RESULTS_JSONL = path.join(RUNTIME_DIR, "results.jsonl");

/** 虎の巻(docs/編集についての虎の巻.md)の要点だけをプロンプトへ埋め込む（全文は長すぎるため）。 */
const EDIT_BIBLE_SUMMARY = `
編集の判断基準（要点。詳細は docs/編集についての虎の巻.md）:
- 選ぶのは「文の先頭から文の末尾まで」の完全な文だけ。文の途中・単語の途中を含む断片は選ばない。
- 選んだ一片は、それ単体で読んで何の話か分かること。指示語(それ/あれ)や接続詞(で/だから)で始まる断片は選ばない。
- カメラチェック・マイクテスト・撮影の裏側の会話（「本番いきます」「はい、カット」等）は落とす。
- 本題と無関係な個人的な脱線（本題に戻る前の雑談）は落とす。ただし脱線から本題へ戻る締めの一文は、
  それ単体で意味が通るなら残してよい。
- 動画が「これから◯つ紹介します」等の約束をしていたら、その約束の数だけ律儀に拾う（約束を破らない）。
- 迷ったら広く残す（狭く削って意味を壊すより、多少長くなる方が安全）。
`.trim();

function usage() {
  console.error("使い方: node src/edit-job.mjs <jobId>");
  process.exit(1);
}

// マスター指示(2026-08-18)「中止機能が欲しい」: サーバー(server/job-cancel.mjs)が
// work/<jobId>/.cancel を置くと、次の工程の合間でここに引っかかって打ち切る。
// 実行中の1コマンド（ffmpeg・claude -p 等）の途中では止めない（工程の切れ目という
// 安全な粒度でしか打ち切らない）。
class CancelledError extends Error {}

function checkCancelled(workDir) {
  if (fs.existsSync(path.join(workDir, ".cancel"))) {
    throw new CancelledError("中止されました");
  }
}

function readInboxJob(jobId) {
  const text = fs.readFileSync(CHAT_INBOX, "utf-8");
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    if (obj && obj.id === jobId) return obj;
  }
  throw new Error(`chat-inbox.jsonl に jobId=${jobId} が見つかりません`);
}

function appendResult(record) {
  fs.appendFileSync(RESULTS_JSONL, JSON.stringify(record) + "\n", "utf-8");
}

/** python3 が Windows Store のスタブを指す環境があるため、実体の python を優先的に探す。 */
function resolvePython() {
  const candidates = [];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const programsDir = path.join(localAppData, "Programs", "Python");
    if (fs.existsSync(programsDir)) {
      for (const entry of fs.readdirSync(programsDir)) {
        const exe = path.join(programsDir, entry, "python.exe");
        if (fs.existsSync(exe)) candidates.push(exe);
      }
    }
  }
  candidates.push("python3", "python");
  for (const cand of candidates) {
    const r = spawnSync(cand, ["--version"], { encoding: "utf-8" });
    if (r.status === 0 && !/WindowsApps/i.test(cand)) return cand;
  }
  throw new Error("実行可能な python が見つかりません");
}

function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf-8", ...opts });
  if (r.status !== 0) {
    throw new Error(`コマンド失敗: ${cmd} ${args.join(" ")}\n${r.stderr ?? r.stdout ?? ""}`);
  }
  return r.stdout ?? "";
}

// ---------- 1. 文字起こし ----------
function transcribe(videoPath, workDir) {
  const py = resolvePython();
  const out = path.join(workDir, "transcript.json");
  console.log("[1/7] 文字起こし中（Groqがあれば自動使用）…");
  runSync(py, [path.join(VIDEO_SHORTS_DIR, "src", "transcribe.py"), videoPath, out, "--lang", "ja", "--backend", "auto"], {
    cwd: VIDEO_SHORTS_DIR,
  });
  return JSON.parse(fs.readFileSync(out, "utf-8"));
}

// ---------- 2. 無音実測 ----------
function detectSilences(videoPath) {
  console.log("[2/7] 無音区間を実測中…");
  const r = spawnSync("ffmpeg", ["-i", videoPath, "-af", "silencedetect=noise=-30dB:d=0.15", "-f", "null", "-"], {
    encoding: "utf-8",
  });
  const text = r.stderr ?? "";
  const silences = [];
  let pendingStart = null;
  for (const line of text.split("\n")) {
    const sm = line.match(/silence_start:\s*([\d.]+)/);
    if (sm) pendingStart = Number(sm[1]);
    const em = line.match(/silence_end:\s*([\d.]+)/);
    if (em && pendingStart != null) {
      silences.push({ start: pendingStart, end: Number(em[1]) });
      pendingStart = null;
    }
  }
  return silences;
}

/** マスター指示（2026-08-18）: 語尾の余韻として無音へ最大0.3秒だけ食い込ませる
 * （旧実装 trim-plan.mjs の AFTER_SPEECH_MARGIN_SEC を踏襲）。無音自体より長くは伸ばさない
 * （虎の巻 原則4: 元々そこにあった無音だけを使う。合成しない）。 */
const AFTER_SPEECH_MARGIN_SEC = 0.3;

/**
 * t に最も近い無音区間を探し、kind に応じて余韻/助走ぶんだけ寄せた時刻を返す。
 * 見つからなければ t をそのまま返す（切らない安全側）。
 * @param {"start"|"end"} kind "end"=区間の終わり(語尾。無音の頭から0.3秒残す)、
 *   "start"=区間の始まり(語頭。無音の尾から0.3秒遡って助走を付ける)
 */
function snapToSilence(t, silences, kind, maxDistance = 1.0) {
  let best = null;
  let bestDist = Infinity;
  for (const s of silences) {
    const dist = t >= s.start && t <= s.end ? 0 : Math.min(Math.abs(t - s.start), Math.abs(t - s.end));
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  if (!best || bestDist > maxDistance) return t;
  const edgeMargin = Math.min(0.05, (best.end - best.start) / 4);
  if (kind === "end") {
    return Math.min(best.start + AFTER_SPEECH_MARGIN_SEC, best.end - edgeMargin);
  }
  return Math.max(best.end - AFTER_SPEECH_MARGIN_SEC, best.start + edgeMargin);
}

// ---------- 3. 区間選定（Opus5） ----------
async function selectSegments(transcript, instruction, settings, workDir) {
  console.log("[3/7] 区間選定中（Opus5）…");
  const segList = transcript.segments
    .map((s, i) => `${i}\t${s.start.toFixed(2)}-${s.end.toFixed(2)}\t${s.text}`)
    .join("\n");
  const prompt = `あなたは動画編集者です。以下の文字起こし（セグメント番号付き）から、
指示と目標の尺に合うよう、採用するセグメント番号だけを選んでください。

${EDIT_BIBLE_SUMMARY}

# 目標の尺
${settings.targetDurationSec}秒

# ユーザーの指示（空なら「良い抜粋を自動で作る」という指示として扱う）
${instruction || "(指示なし。上の編集基準に従って自動で判断してください)"}

# セグメント一覧（番号 タブ 開始-終了秒 タブ 本文）
${segList}

# 出力形式
他の文章を一切書かず、次のJSON形式のみを出力してください:
{"keep": [[開始番号, 終了番号], [開始番号, 終了番号], ...]}
各ペアは "この番号からこの番号までを連続して採用する" という意味です（開始・終了とも上のセグメント番号）。`;

  const stdout = await runClaudeJson({
    stdin: prompt,
    cwd: workDir,
    timeoutMs: 300_000,
    onLog: (l) => console.log(l),
  });
  const jsonMatch = String(stdout).match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`区間選定の応答からJSONを取り出せませんでした: ${String(stdout).slice(0, 300)}`);
  const parsed = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(parsed.keep) || parsed.keep.length === 0) {
    throw new Error("区間選定の応答に keep 配列がありません");
  }
  return parsed.keep.map(([a, b]) => {
    const from = transcript.segments[Math.min(a, b)];
    const to = transcript.segments[Math.max(a, b)];
    if (!from || !to) throw new Error(`不正なセグメント番号: ${a}, ${b}`);
    return { start: from.start, end: to.end };
  });
}

// ---------- 4. 無音スナップ ----------
function snapRanges(ranges, silences) {
  return ranges.map((r) => ({
    start: snapToSilence(r.start, silences, "start"),
    end: snapToSilence(r.end, silences, "end"),
  }));
}

// ---------- 5. 切り出し・結合 ----------
function cutAndConcat(videoPath, ranges, outPath) {
  console.log("[4/7] 切り出し・結合中…");
  const filters = [];
  const labels = [];
  ranges.forEach((r, i) => {
    const dur = r.end - r.start;
    const fadeOutSt = Math.max(0, dur - 0.02);
    filters.push(`[0:v]trim=${r.start}:${r.end},setpts=PTS-STARTPTS[v${i}]`);
    filters.push(
      `[0:a]atrim=${r.start}:${r.end},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.02,afade=t=out:st=${fadeOutSt}:d=0.02[a${i}]`
    );
    labels.push(`[v${i}][a${i}]`);
  });
  filters.push(`${labels.join("")}concat=n=${ranges.length}:v=1:a=1[outv][outa]`);
  runSync("ffmpeg", [
    "-y",
    "-i", videoPath,
    "-filter_complex", filters.join(";\n"),
    "-map", "[outv]", "-map", "[outa]",
    "-c:v", "libx264", "-crf", "18", "-preset", "medium",
    "-c:a", "aac", "-b:a", "192k",
    outPath,
  ]);
}

// ---------- 6. 縦型変換 ----------
/** 映像の実寸(幅・高さ)を取得する。字幕の PlayResX/Y・帯の座標を実寸に追従させるために使う。 */
function probeDimensions(videoPath) {
  const out = runSync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x",
    videoPath,
  ]).trim();
  const [width, height] = out.split("x").map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(`映像の実寸を取得できませんでした: ${out}`);
  }
  return { width, height };
}

/** settings.aspect==="portrait" のときだけ呼ぶ。1080x1920へletterbox変換する
 * （余白は黒帯、映像は縮小のみで欠けさせない）。
 *
 * 【2026-08-18】既存の顔追跡クロップ実装 src/reframe.py を先に試したが、Windows環境で
 * "[WinError 206] ファイル名または拡張子が長すぎます" で失敗した。フレームごとのx位置を
 * 1本の -vf 条件式（if(eq(n,0),..),if(eq(n,1),..)... をフレーム数ぶん連結）に埋め込む実装のため、
 * 動画が長い（フレーム数が多い）と Windows のコマンドライン長上限を超える。これは
 * reframe.py 自体の作り（Linux/macOSでのみ検証されていた可能性）に起因する既存の不具合で、
 * 今回の「縦横比を反映させる」の範囲を超える改修が要る。ここでは確実に動く letterbox 方式
 * （顔追跡なし）で「指定した縦横比になる」ことを優先し、顔追跡クロップは別課題として切り分ける。 */
function reframeToPortrait(inPath, outPath, workDir) {
  console.log("[5/7] 縦型変換中（letterbox）…");
  runSync("ffmpeg", [
    "-y",
    "-i", inPath,
    "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1",
    "-c:v", "libx264", "-crf", "18", "-preset", "medium",
    "-c:a", "copy",
    outPath,
  ], { cwd: workDir });
}

// ---------- 7. 字幕 ----------
//
// 2026-08-18 マスター指示「字幕は調べろ。2行で収まるにはどうするか？をGithubから。サブ使え」
// を受けて、自己流の場当たり的な修正（文字数で割る→単語途中分断／無音でのみ区切る→はみ出し／
// \N追加→カード重複、の3連続事故）をやめ、GitHub上の実績あるショート動画自動字幕ツール
// unconv/captacity（word-timestamp から TikTok/Shorts 風の字幕を焼く定番OSS）の設計を読み、
// 考え方だけを移植した（パッケージとしては導入していない。requirements: 新規npm依存なし）。
//
// captacity の要点（captacity/text_drawer.py の calculate_lines()/fits_frame()、
// captacity/segment_parser.py の parse()）:
//   - 「カード（表示単位）をどこで区切るか」と「1カード内でどう行分割するか」を、
//     同じ1つの判定関数（fits_frame = 実測幅で行数を数える）で統一する。
//     行分割用の関数を先に作り、カード分割はその行分割関数を使い回して
//     「次の語を足しても行数の上限に収まるか」だけを条件に貪欲に語を積む
//     （segment_parser.parse: fit_function が false を返すまで words を1つずつ足す）。
//   - 語は空白区切りの1トークンとして扱い、行分割は語の"境界"でしか折らない
//     （calculate_lines: `line += word + " "` → 測って超えたら直前の行を確定。
//     1語だけで幅を超える場合だけ、割らずにそのまま1行に置く＝はみ出しより分断しないことを優先）。
//   - 無音ギャップや句読点には一切依存しない。行数の上限（＝幅）だけが唯一の必須条件なので、
//     Groq のように単語間ギャップがほとんど取れないバックエンドでも、カードは必ず上限行数で
//     区切られる（今回の事故4の直接の原因＝ギャップ依存を解消する）。
//
// このプロジェクトの制約に合わせて追加した点（captacityそのままではない部分）:
//   - 幅の見積りは自作（video-shorts/src/subtitle-styles.mjs の FONT_CATALOG.kaku の実測比
//     wideRatio/narrowRatio。buildAssFile が実際に焼く書体 "Noto Sans JP Black" と一致させる）。
//     captacity は Pillow で実レンダリングして測るが、こちらは他の字幕コード（srt-builder.mjs）
//     と同じ「実測比を文字数に掛ける」方式に合わせた（依存追加なし・既存資産と一貫させるため）。
//   - 句点(。！？」)・実測ギャップ（無音）は、行数の上限を破らない範囲でだけ使う「早期区切りの
//     ヒント」として残した（カードが行数いっぱいまで毎回詰め込まれ、文の切れ目を無視して
//     次の文と同じカードに同居するのを防ぐ。ただしカードが十分埋まっているときだけ効かせ、
///    極端に短いカードが乱発しないようにする）。この早期区切りは常に「必須条件（行数の上限）」
//     より弱いので、外れても2行以内という保証そのものは揺らがない。

const CAPTION_FONT = FONT_CATALOG.kaku; // buildAssFile が実際に焼く書体(Noto Sans JP Black)と一致させる
const CAPTION_FONT_SIZE = 64;
const CAPTION_MAX_LINES = 2; // マスター指示「2行で収まるには」
const CAPTION_MARGIN_LR = 60; // buildAssFile の Style行 MarginL/MarginR と一致させる
// 1行に使ってよい幅の上限（可用幅に対する割合）。1.0いっぱいまで詰めると測定誤差で
// 画面端に接するので、srt-builder.mjs の CAPTION_LINE_FILL_MAX と同じ 0.9 を使う。
const LINE_FILL_MAX = 0.9;

/** 全角相当(CJK等)なら2、半角なら1（srt-builder.mjs の charDisplayWidth と同じ判定）。 */
function charDisplayWidth(ch) {
  const cp = ch.codePointAt(0);
  const WIDE_RANGES = [
    [0x1100, 0x115f],
    [0x2e80, 0xa4cf],
    [0xac00, 0xd7a3],
    [0xf900, 0xfaff],
    [0xff00, 0xff60],
    [0xffe0, 0xffe6],
    [0x20000, 0x3fffd],
  ];
  return WIDE_RANGES.some(([a, b]) => cp >= a && cp <= b) ? 2 : 1;
}

/** 文字列の描画幅(px)の見積り（実測比 wideRatio/narrowRatio × フォントサイズを積む）。 */
function textWidthPx(text) {
  let px = 0;
  for (const ch of text) {
    const wide = charDisplayWidth(ch) === 2;
    px += CAPTION_FONT_SIZE * (wide ? CAPTION_FONT.wideRatio : CAPTION_FONT.narrowRatio);
  }
  return px;
}

/** 1行に収める幅の予算(px)。canvasW は焼き込み先の実解像度（buildAssFile の PlayResX）。 */
export function lineBudgetPx(canvasW) {
  const available = canvasW - CAPTION_MARGIN_LR * 2;
  return available > 0 ? available * LINE_FILL_MAX : Infinity;
}

/**
 * 語配列を、画面幅に収まる行へ貪欲に詰める（captacity の calculate_lines() 相当）。
 * 語(w.w)は不可分な1トークンとして扱い、**語と語の境界でしか折らない**（単語の途中では
 * 絶対に割らない＝マスター制約）。1語だけで1行の予算を超える場合（長いURL等・通常の
 * 日本語の語では起きない）は、割らずにそのまま1行として置く（はみ出しより分断しない
 * ことを優先。captacity も同じ方針＝ "too long for frame" でも割らずにそのまま置く）。
 */
export function packWordsIntoLines(words, budgetPx) {
  const lines = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? cur + w.w : w.w;
    if (cur && textWidthPx(candidate) > budgetPx) {
      lines.push(cur);
      cur = w.w;
    } else {
      cur = candidate;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** 直前の語が句読点（文の終わり）で終わっているか。行数の上限を破らない範囲でだけ使う
 * 早期区切りのヒント（下の buildCaptionCards 参照）。 */
function endsSentence(word) {
  return /[。！？」]$/.test(word.w);
}

/**
 * カードの区切りを決める（captacity の segment_parser.parse() 相当）。
 * 必須条件は1つだけ：**次の語を足すと2行に収まらなくなったら、そこで区切る**。
 * これだけで「単語の途中で割れない」「必ず2行以内に収まる」の両方が、音声認識バックエンドの
 * ギャップ検出精度に関係なく常に成り立つ（Groqでギャップがほぼ取れない場合でも、幅の判定は
 * 語が積まれるたびに毎回効くため、事故4のような無制限に伸びるカードが発生しない）。
 * 加えて、カードが十分埋まっている（半行以上使っている）ときに限り、文末や大きな無音
 * ギャップでの早期区切りを許す（無くても2行保証は揺らがない、読みやすさのための上乗せ）。
 */
export function buildCaptionCards(relWords, budgetPx) {
  const GAP_BREAK = 0.3; // 実測ギャップがこれ以上なら早期区切りの候補にしてよい
  const MIN_FILL_FOR_EARLY_BREAK = 0.35; // 半行未満で毎回切ると極端に短いカードが乱発する
  const cards = [];
  let cur = [];
  for (const w of relWords) {
    if (cur.length) {
      const candidateLines = packWordsIntoLines([...cur, w], budgetPx);
      const mustBreak = candidateLines.length > CAPTION_MAX_LINES; // 唯一の必須条件
      let preferBreak = false;
      if (!mustBreak) {
        const gapBefore = +(w.start - cur[cur.length - 1].end).toFixed(3);
        const prevEndsSentence = endsSentence(cur[cur.length - 1]);
        if (prevEndsSentence || gapBefore >= GAP_BREAK) {
          const curLines = packWordsIntoLines(cur, budgetPx);
          const usedWidth = textWidthPx(curLines[curLines.length - 1] ?? "");
          preferBreak = usedWidth >= budgetPx * MIN_FILL_FOR_EARLY_BREAK;
        }
      }
      if (mustBreak || preferBreak) {
        cards.push(cur);
        cur = [];
      }
    }
    cur.push(w);
  }
  if (cur.length) cards.push(cur);
  return cards;
}

/** カード内の語を、画面幅に収まるよう\Nで行分割する（単語の途中では絶対に割らない）。
 * buildCaptionCards がすでに「2行以内に収まる」ことを保証した語の集まりだけを渡す前提
 * だが、行分割そのものは独立した関数として持つ（captacity が calculate_lines と
 * fits_frame を分けているのと同じ構成）。 */
export function wrapCardText(words, budgetPx) {
  return packWordsIntoLines(words, budgetPx).join("\\N");
}

// 帯・文字位置の比率（1920x1080基準の実測値からの比率。縦型(1080x1920)等でも同じ見え方になるよう
// PlayResX/Yを実際の映像サイズに合わせたうえで、この比率で座標を再計算する）。
const CAPTION_BAR_Y_RATIO = 780 / 1080;
const CAPTION_BAR_H_RATIO = 300 / 1080;
const CAPTION_MARGIN_V_RATIO = 95 / 1080;

export function buildAssFile(transcript, ranges, assPath, dims) {
  const PLAY_RES_X = dims.width;
  const PLAY_RES_Y = dims.height;
  const marginV = Math.round(PLAY_RES_Y * CAPTION_MARGIN_V_RATIO);
  const budgetPx = lineBudgetPx(PLAY_RES_X);

  let relWords = [];
  let newBase = 0;
  for (const r of ranges) {
    const rel = wordsInRange(transcript.words, r.start, r.end);
    for (const w of rel) relWords.push({ w: w.w, start: w.start + newBase, end: w.end + newBase });
    newBase += r.end - r.start;
  }
  const cards = buildCaptionCards(relWords, budgetPx);
  const LEAD = 0.05;
  const MAXHOLD = 0.6;
  // 終了時刻は「次のカードの表示開始より前」を絶対条件にする（最低表示時間の底上げより優先。
  // 底上げを先に適用すると、間隔の詰まったカード同士で重なって縦に積み上がる事故が起きる）。
  const events = cards
    .map((c, i) => {
      const text = wrapCardText(c, budgetPx).replace(/[{}]/g, "");
      const start = Math.max(0, c[0].start - LEAD);
      const naturalEnd = c[c.length - 1].end + 0.15;
      const hardLimit = i + 1 < cards.length ? cards[i + 1][0].start - LEAD : Infinity;
      const desiredEnd = Math.min(naturalEnd + MAXHOLD, hardLimit);
      const end = Number.isFinite(hardLimit) ? Math.min(Math.max(desiredEnd, start + 0.05), hardLimit) : desiredEnd;
      return { start, end, text };
    })
    .filter((e) => e.end > e.start) // 直後のカードと間隔が無さすぎて潰れた場合は表示しない（重複させない）
    .map((e) => `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},Caption,,0,0,0,,${e.text}`);
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${PLAY_RES_X}
PlayResY: ${PLAY_RES_Y}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${CAPTION_FONT.family},${CAPTION_FONT_SIZE},&H00FFFFFF,&H00000000,&H00000000,1,1,4,0,2,${CAPTION_MARGIN_LR},${CAPTION_MARGIN_LR},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  fs.writeFileSync(assPath, header + events.join("\n") + "\n", "utf-8");
}

function burnCaptions(inPath, assPath, outPath, workDir, dims) {
  console.log("[6/7] 字幕を焼き込み中…");
  // ffmpeg の subtitles フィルタは Windows のドライブレター(C:)をオプション区切りと誤認するため、
  // 作業ディレクトリからの相対パスで渡す（絶対パスのコロンを回避する）。
  const relAss = path.relative(workDir, assPath).split(path.sep).join("/");
  const relFonts = path.relative(workDir, FONTS_DIR).split(path.sep).join("/");
  const barY = Math.round(dims.height * CAPTION_BAR_Y_RATIO);
  const barH = Math.round(dims.height * CAPTION_BAR_H_RATIO);
  runSync(
    "ffmpeg",
    [
      "-y",
      "-i", inPath,
      "-vf", `drawbox=x=0:y=${barY}:w=${dims.width}:h=${barH}:color=black@1.0:t=fill,subtitles=${relAss}:fontsdir=${relFonts}`,
      "-c:v", "libx264", "-crf", "18", "-preset", "medium",
      "-c:a", "copy",
      outPath,
    ],
    { cwd: workDir }
  );
}

// ---------- メイン ----------
async function main() {
  const jobId = process.argv[2];
  if (!jobId) usage();

  const job = readInboxJob(jobId);
  if (!job.video || !job.video.path) throw new Error("このジョブには動画がありません（instructionのみのテスト送信の可能性）");

  const workDir = path.join(RUNTIME_DIR, "work", jobId);
  const outDir = path.join(RUNTIME_DIR, "outputs", jobId);
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  try {
    checkCancelled(workDir);
    const transcript = transcribe(job.video.path, workDir);
    checkCancelled(workDir);
    const silences = detectSilences(job.video.path);
    checkCancelled(workDir);
    const rawRanges = await selectSegments(transcript, job.instruction, job.settings, workDir);
    const ranges = snapRanges(rawRanges, silences);
    checkCancelled(workDir);

    const trimmedPath = path.join(workDir, "trimmed.mp4");
    cutAndConcat(job.video.path, ranges, trimmedPath);
    checkCancelled(workDir);

    let framedPath = trimmedPath;
    if (job.settings?.aspect === "portrait") {
      framedPath = path.join(workDir, "portrait.mp4");
      reframeToPortrait(trimmedPath, framedPath, workDir);
      checkCancelled(workDir);
    }
    const dims = probeDimensions(framedPath);

    const resultPath = path.join(outDir, "result.mp4");
    if (job.settings?.caption) {
      const assPath = path.join(workDir, "captions.ass");
      buildAssFile(transcript, ranges, assPath, dims);
      checkCancelled(workDir);
      burnCaptions(framedPath, assPath, resultPath, workDir, dims);
    } else {
      fs.copyFileSync(framedPath, resultPath);
    }

    console.log("[7/7] 完了記録を書き込み中…");
    appendResult({ id: jobId, status: "done", output: resultPath, at: new Date().toISOString() });
    console.log(`完了: ${resultPath}`);
  } catch (err) {
    if (err instanceof CancelledError) {
      appendResult({ id: jobId, status: "cancelled", message: err.message, at: new Date().toISOString() });
      console.log(`中止: ${jobId}`);
    } else {
      appendResult({ id: jobId, status: "error", message: err.message, at: new Date().toISOString() });
      console.error(`失敗: ${err.message}`);
      process.exitCode = 1;
    }
  }
}

// 検証スクリプト等からこのファイルを import して buildCaptionCards/wrapCardText/buildAssFile を
// 単体で叩けるように、`node src/edit-job.mjs <jobId>` として直接実行されたときだけ main() を
// 走らせる（import 時に process.exit(1) を伴う usage() が即実行されるのを防ぐ）。
// 実行方法(使い方コメント)は変えていない＝直接実行時の挙動は従来どおり。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
