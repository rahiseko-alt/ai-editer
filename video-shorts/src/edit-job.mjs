// video-shorts [固定手順] .runtime/chat-inbox.jsonl の1ジョブを、実際に編集して
// .runtime/outputs/<jobId>/result.mp4 へ書き出し、.runtime/results.jsonl へ完了を記録する。
//
// 【2026-08-19 マスター指示】「UIに素材を投げる→文字起こしする→お前が内容を決める→
// FFmpegで書き出し」にしろ。以前は区間選定を別プロセスの claude -p（毎回まっさらな
// 使い捨てのOpus5呼び出し。この対話の文脈も虎の巻も合格条件も持たない）に丸投げしており、
// それが「その名も、コズム」が「も、コズム」になるような、意味の通らない断片を生む
// 直接原因だった（docs/failures.md 参照）。「内容を決める」のは、この対話をしている
// セッション自身にする。そのため2コマンドに分割した:
//
//   node src/edit-job.mjs prepare <jobId>
//     文字起こし→誤字修正→無音実測→文節化（BudouX）までを自動実行する。
//     ワーカー（server/job-worker.mjs）がジョブ投入を検知して自動で呼ぶ。
//     結果は work/<jobId>/units.json（番号付き文節一覧）・silences.json に残る。
//     ★ここで自動処理は止まる。区間選定はしない。★
//
//   node src/edit-job.mjs render <jobId>
//     work/<jobId>/keep.json（{"keep":[[開始文節番号,終了文節番号],...],
//     "applied":[...], "notApplied":[...]}）を読み、無音スナップ・言い淀み除去・
//     切り出し・縦型変換・字幕・出力までを実行する。
//     ★keep.json は、このセッションが units.json を実際に読んで直接書く。★
//
// 手順（render 側。固定・この順で必ず実行する）:
//   1. 無音スナップ（実測した無音の内側へ寄せる）
//   2. 言い淀みを切る（母音性フィラーのみ。消せないものは消さない）
//   3. 切り出し・結合（短いクロスフェード付き）
//   4. 縦型変換（settings.aspect==="portrait" のときのみ。letterbox 方式）
//   5. 字幕（caption:true のときのみ。白文字＋黒縁だけで焼く＝黒帯は敷かない。
//      BudouX の文節を最小単位に詰めるので語の途中で折れない。接続助詞で終わるカードは次へ送る。
//      文字サイズ・縁の太さ・余白はすべて実際の映像サイズから算出する）
//   → 出力・完了記録

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { aiCaptionFixStage, createDefaultRunModel } from "./ai-caption-fix.mjs";
import { planFillerCuts, subtractCuts } from "./filler-cut.mjs";
import { wordsInRange, assTime } from "./srt-builder.mjs";
import { FONTS_DIR, FONT_CATALOG, fontSizeForHeight } from "./subtitle-styles.mjs";
import { Parser as BudouxParser } from "./vendor/budoux/parser.mjs";
import { model as BUDOUX_JA_MODEL } from "./vendor/budoux/ja-model.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const VIDEO_SHORTS_DIR = path.resolve(__dirname, "..");
const RUNTIME_DIR = path.join(REPO_ROOT, ".runtime");
const CHAT_INBOX = path.join(RUNTIME_DIR, "chat-inbox.jsonl");
const RESULTS_JSONL = path.join(RUNTIME_DIR, "results.jsonl");

/** docs/合格条件.md と docs/編集についての虎の巻.md の要点をプロンプトへ埋め込む（全文は長すぎるため）。
 * 合否は「人間が見て良い編集か」だけで決まる（マスター指示 2026-08-19）。 */
const EDIT_BIBLE_SUMMARY = `
# ダイジェストとは何か（ここを外すと、そもそも成果物にならない）
ダイジェストは**背骨だけ・一番おいしいところだけ**で構成されたものです。
山場を選んで繋ぐ（抽出型）のであって、「無音や言い淀みを間引いて少し短くする」
（短縮編集）ではありません。
**長さの目標はありません。** 何秒に収めるかを考えないでください。
考えるのは「この話の背骨はどこか」「一番おいしいのはどこか」だけです。
背骨と山場だけを選んだ結果が何秒になっても、それが正しい長さです。

# 構成（時系列を守る必要はありません）
1. 冒頭 = 結論そのもの。動画中で最も強い一文を、素材の順番を無視して先頭に置く。
   挨拶・自己紹介・前置き・「本番いきます」のような掛け声で始めるのは失格です。
2. 本体 = それ単体で意味が通るブロックを2〜3個。
3. 締め = 見終わって持ち帰るものがある一文で閉じる。
順番の入れ替えは許されます。ただし因果（Aの説明がBの前提）が壊れる並べ替えは禁止です。

# 必ず捨てる（優先度順）
挨拶 → 自己紹介 → 前置き・掛け声 → 本題から逸れた余談 → 同じ話の繰り返し → 長すぎる間

# 必ず残す
結論となる主張 / 話の転換点 / 感情のピーク

# 約束と回収（ここを外すと、見た人は「話が終わっていない」と感じます）
素材の中に「これから3つ紹介します」「理由は2つあります」のような**数の約束**や、
「なぜかというと」のような**問いの提示**があるとき、次のどちらかしか選べません。
  (a) その約束の一文を採用し、**約束した数だけ全部**拾う。
  (b) 約束の一文ごと採用しない（そうすれば回収の義務も発生しません）。
**「3つ紹介します」を入れて1つしか見せない、は最も重い失格です。**
長さが足りなくて全部拾えないなら、迷わず (b) を選び、1つの話題を最後まで見せてください。

# 切り方（これを破ったら他が良くても失格）
- 選ぶのは「文の先頭から文の末尾まで」の完全な文だけ。文の途中・単語の途中を含む断片は選ばない。
- **どの区間も、冒頭が接続詞(そこで/で/だから/でも)・助詞・指示語(それ/これ/あの件)で始まってはいけません。**
- 末尾は言い切りで終わること（接続助詞「〜て」「〜けど」や言い差しで終わらない）。
- 選んだ一片は、それ単体で読んで何の話か分かること。
- 動画内で使う指示語は、その指す先が採用した区間の中に無ければいけません。
- 冒頭で立てた問い・約束には、採用した区間の中で必ず答えが出ていること（言いかけて終わらない）。

# 絶対禁止
元の発言の意図や趣旨を変えてしまう切り方。本人が言っていない文を継ぎ接ぎで作ること。
迷ったら広く残す（狭く削って意味を壊すより、多少長い方が安全）。
`.trim();

function usage() {
  console.error("使い方: node src/edit-job.mjs prepare <jobId>  （文字起こし〜文節化。ワーカーが自動実行）");
  console.error("       node src/edit-job.mjs render <jobId>   （work/<jobId>/keep.json を読んで書き出し）");
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
  console.log("[1/8] 文字起こし中（Groqがあれば自動使用）…");
  runSync(py, [path.join(VIDEO_SHORTS_DIR, "src", "transcribe.py"), videoPath, out, "--lang", "ja", "--backend", "auto"], {
    cwd: VIDEO_SHORTS_DIR,
  });
  return JSON.parse(fs.readFileSync(out, "utf-8"));
}

// ---------- 2. 無音実測 ----------
function detectSilences(videoPath) {
  console.log("[3/8] 無音区間を実測中…");
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

/** BudouX のパーサは状態を持たないので1個を使い回す（モデルの読み込みは1回だけ）。 */
let _budoux = null;
function budouxParser() {
  if (!_budoux) _budoux = new BudouxParser(BUDOUX_JA_MODEL);
  return _budoux;
}

/**
 * ffmpeg silencedetect が語中の子音の破裂音などを誤検出することがある。
 *
 * 【2026-08-19 実測した3連鎖の事故】
 * (1) 「きれいに」の"き"と"れ"の間に 0.15 秒の無音を検出し、語の途中で切れた。
 * (2) (1) の対策として「0.2秒未満は無視」という長さの閾値を入れたところ、
 *     今度は「動画」という語の内部にある 0.308 秒の誤検出無音（閾値を通過してしまう）
 *     にスナップし、"今日は"ごと語の先頭が削れた。長さの閾値は対症療法で、
 *     閾値をどこに引いても新しい誤検出が閾値の内側に来れば同じ事故が形を変えて起きる。
 * (3) 根本原因を「無音が語の内部にあるか」に切り替え、word-level timestamp と
 *     突き合わせる判定に直したが、まだ (1) が再発した。原因は Groq の日本語
 *     word timestamp が文字単位に近い部分語で返ること（既知の仕様。「きれいに」が
 *     "き""れ""い""に"の4語に分かれている）。無音がその**2つの部分語の境界**に
 *     またがっていたため、「1語に完全内包」の判定をすり抜けた。
 * → 判定対象を部分語ではなく **BudouX の文節（groupIntoPhrases の結果）** にする。
 *   文節は「意味のある1つの単位」なので、その内部にまたがる無音は誤検出とみなせる。
 */
function isInsideAnyWord(silence, phraseUnits) {
  const EPS = 0.005;
  return phraseUnits.some((u) => silence.start >= u.start - EPS && silence.end <= u.end + EPS);
}

/**
 * t に最も近い無音区間を探し、kind に応じて余韻/助走ぶんだけ寄せた時刻を返す。
 * 見つからなければ t をそのまま返す（切らない安全側）。
 * @param {"start"|"end"} kind "end"=区間の終わり(語尾。無音の頭から0.3秒残す)、
 *   "start"=区間の始まり(語頭。無音の尾から0.3秒遡って助走を付ける)
 * @param {{start:number,end:number,w:string}[]} phraseUnits 文節の内部の誤検出無音を除外するために使う
 */
function snapToSilence(t, silences, kind, phraseUnits, maxDistance = 1.0) {
  let best = null;
  let bestDist = Infinity;
  for (const s of silences) {
    if (isInsideAnyWord(s, phraseUnits)) continue;
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

// ---------- 2.5 台本化（文節の切れ目を取る） ----------
//
// 【2026-08-19】ここは最初 LLM に「文と文節の切れ目の添字」を返させていたが、実測して捨てた。
//   - 遅い（かたまりごとに claude -p の往復が増える）
//   - 精度が出ない（複合語を割るなと指示しても「ラッシュ/カット」を割った）
// 代わりに BudouX（Google, Apache-2.0, src/vendor/budoux）を同梱して使う。辞書も外部通信も
// 不要で 0.03ms/回、同じ入力なら常に同じ出力になる。
//
// 実測（同じ素材・同じ採用区間で比較）:
//   カード末が語の途中で終わる   縦型 85% → 0% / 横型 75% → 0%
//   行の中で語が割れる           縦型 29箇所 → 0 / 横型 6箇所 → 0
// 残る欠陥（助詞・接続助詞で終わるカード）は句読点が無い限り解けない。docs/caption-plan.md 参照。

/** 語の並びから、BudouX の文節境界で区切った塊を作る。塊は {w,start,end} を持つので、
 * packWordsIntoLines / buildCaptionCards がそのまま1トークンとして扱える。
 *
 * 【時刻の戻し方】BudouX は文字列しか見ないので、語を連結した文字列の「文字位置」で
 * 元の語へ逆写像し、塊の start = 先頭語の start、end = 末尾語の end とする。
 * （文字を足し引きしないので、この対応は必ず一致する）
 */
export function groupIntoPhrases(words) {
  if (!words.length) return [];
  const text = words.map((w) => w.w).join("");
  const phrases = budouxParser().parse(text);

  const units = [];
  let wordIdx = 0;
  let consumedInWord = 0; // いま見ている語のうち、すでに塊へ配った文字数
  for (const phrase of phrases) {
    let need = phrase.length;
    const first = wordIdx;
    while (need > 0 && wordIdx < words.length) {
      const remain = words[wordIdx].w.length - consumedInWord;
      if (remain > need) {
        // 文節の境界が語の内側に来た場合（部分語をまたがず割った場合）。
        // 語は分割せず、この語まで塊に含める（欠けさせない＝虎の巻 原則3）。
        consumedInWord += need;
        need = 0;
      } else {
        need -= remain;
        consumedInWord = 0;
        wordIdx += 1;
      }
    }
    const last = Math.max(first, (consumedInWord > 0 ? wordIdx : wordIdx - 1));
    units.push({
      w: phrase,
      start: words[first].start,
      end: words[Math.min(last, words.length - 1)].end,
      br: null,
    });
  }
  return units;
}


// ---------- 4. 無音スナップ ----------
function snapRanges(ranges, silences, phraseUnits) {
  return ranges.map((r) => ({
    start: snapToSilence(r.start, silences, "start", phraseUnits),
    end: snapToSilence(r.end, silences, "end", phraseUnits),
  }));
}

// ---------- 5. 切り出し・結合 ----------
function cutAndConcat(videoPath, ranges, outPath) {
  console.log("[6/8] 切り出し・結合中…");
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
  console.log("[7/8] 縦型変換中（letterbox）…");
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
const CAPTION_MAX_LINES = 2; // マスター指示「2行で収まるには」
// 左右の余白（画面幅に対する割合）。以前は 60px 固定だったが、それは縦型(幅1080)を前提にした値で、
// 横型(幅1920)では端に寄りすぎていた。フォントサイズと同じく解像度に追従させる。
const CAPTION_MARGIN_LR_RATIO = 60 / 1080;
// 1行に使ってよい幅の上限（可用幅に対する割合）。1.0いっぱいまで詰めると測定誤差で
// 画面端に接するので、srt-builder.mjs の CAPTION_LINE_FILL_MAX と同じ 0.9 を使う。
const LINE_FILL_MAX = 0.9;

/**
 * その映像に焼く字幕の寸法を、映像の実寸から1箇所で決める。
 *
 * 【2026-08-19】以前は Fontsize を 64 に固定していた。libass の Fontsize は「文字そのものの
 * 大きさ」ではなく上下の余白を含む高さに効くので、64 は実際の字の高さにすると
 * 64 × 0.69 = 44px ＝ 1920px 高に対して 2.3% しかなく、マスターが選んだ 5.2%（案C・
 * subtitle-styles.mjs の CAPTION_EM_RATIO）の半分以下だった。しかも解像度に追従しない。
 * `fontSizeForHeight()` は subtitle-styles.mjs に既にあったのに、どこからも呼ばれていなかった。
 * 縁取りも 4 固定だったが、書体ごとの実測値 outlineRatio から出す（黒帯を外したので、
 * 背景から字を切り離すのは縁取りだけが担う）。
 */
function captionMetrics(dims) {
  const fontSize = fontSizeForHeight(dims.height, CAPTION_FONT);
  const marginLR = Math.round(dims.width * CAPTION_MARGIN_LR_RATIO);
  const available = dims.width - marginLR * 2;
  return {
    fontSize,
    marginLR,
    marginV: Math.round(dims.height * CAPTION_MARGIN_V_RATIO),
    outline: Math.max(1, Math.round(fontSize * CAPTION_FONT.outlineRatio)),
    budgetPx: available > 0 ? available * LINE_FILL_MAX : Infinity,
  };
}

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
function textWidthPx(text, fontSize) {
  let px = 0;
  for (const ch of text) {
    const wide = charDisplayWidth(ch) === 2;
    px += fontSize * (wide ? CAPTION_FONT.wideRatio : CAPTION_FONT.narrowRatio);
  }
  return px;
}

/**
 * 語配列を、画面幅に収まる行へ貪欲に詰める（captacity の calculate_lines() 相当）。
 * 語(w.w)は不可分な1トークンとして扱い、**語と語の境界でしか折らない**（単語の途中では
 * 絶対に割らない＝マスター制約）。1語だけで1行の予算を超える場合（長いURL等・通常の
 * 日本語の語では起きない）は、割らずにそのまま1行として置く（はみ出しより分断しない
 * ことを優先。captacity も同じ方針＝ "too long for frame" でも割らずにそのまま置く）。
 */
export function packWordsIntoLines(words, budgetPx, fontSize) {
  const lines = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? cur + w.w : w.w;
    if (cur && textWidthPx(candidate, fontSize) > budgetPx) {
      lines.push(cur);
      cur = w.w;
    } else {
      cur = candidate;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** その塊が文の終わりか。行数の上限を破らない範囲でだけ使う早期区切りのヒント。
 *
 * 【2026-08-19 実測】Groq の日本語文字起こしには句読点が一切付かないため、この判定は
 * 一度も成立していない＝早期区切りは事実上死んでいる。カードは「2行いっぱいまで詰める」
 * だけになる。ここを本当に効かせるには文の切れ目（句読点）が要る。docs/caption-plan.md 参照。 */
function endsSentence(unit) {
  return unit.br === "文" || /[。！？」]$/.test(unit.w);
}

// 末尾がこれで終わるカードは、次へ続く途中で切れている（虎の巻 §2-4「接続助詞・言い差しで
// 終わるのは禁止」）。文の終わりと判定された塊には適用しない（「〜から。」等は文として閉じている）。
const DANGLING_TAIL_RE = /(?:って|て|で|けど|けれど|けれども|が|し|から|ので|のに|たら|れば|なら|ながら|つつ|ものの|とか|や|に|を|は|も|の|と)$/;

/**
 * 接続助詞・言い差しで終わっているカードの末尾の文節を、次のカードへ送る（虎の巻 §2-4）。
 * 送った結果カードが空になるなら送らない（欠けさせるより、途中で切れている方がまし＝原則3）。
 */
export function fixDanglingCardTails(cards, budgetPx, fontSize) {
  for (let i = 0; i < cards.length - 1; i++) {
    const cur = cards[i];
    while (cur.length >= 2) {
      const last = cur[cur.length - 1];
      if (endsSentence(last) || !DANGLING_TAIL_RE.test(last.w)) break;
      // 送り先が2行に収まらなくなるなら送らない。2行以内という保証の方が優先で、
      // これを破ると字幕が画面外へ積み上がる（この見張りが無くて実際に3行のカードが出た）。
      if (packWordsIntoLines([last, ...cards[i + 1]], budgetPx, fontSize).length > CAPTION_MAX_LINES) break;
      cards[i + 1].unshift(cur.pop());
    }
  }
  return cards.filter((c) => c.length > 0);
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
export function buildCaptionCards(relWords, budgetPx, fontSize) {
  const GAP_BREAK = 0.3; // 実測ギャップがこれ以上なら早期区切りの候補にしてよい
  const MIN_FILL_FOR_EARLY_BREAK = 0.35; // 半行未満で毎回切ると極端に短いカードが乱発する
  const cards = [];
  let cur = [];
  for (const w of relWords) {
    if (cur.length) {
      const candidateLines = packWordsIntoLines([...cur, w], budgetPx, fontSize);
      const mustBreak = candidateLines.length > CAPTION_MAX_LINES; // 唯一の必須条件
      let preferBreak = false;
      if (!mustBreak) {
        const gapBefore = +(w.start - cur[cur.length - 1].end).toFixed(3);
        const prevEndsSentence = endsSentence(cur[cur.length - 1]);
        if (prevEndsSentence || gapBefore >= GAP_BREAK) {
          const curLines = packWordsIntoLines(cur, budgetPx, fontSize);
          const usedWidth = textWidthPx(curLines[curLines.length - 1] ?? "", fontSize);
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
export function wrapCardText(words, budgetPx, fontSize) {
  return packWordsIntoLines(words, budgetPx, fontSize).join("\\N");
}

// 字幕を画面下からどれだけ浮かせるか（映像高に対する割合）。
const CAPTION_MARGIN_V_RATIO = 95 / 1080;

export function buildAssFile(transcript, ranges, assPath, dims) {
  const PLAY_RES_X = dims.width;
  const PLAY_RES_Y = dims.height;
  const { fontSize, marginLR, marginV, outline, budgetPx } = captionMetrics(dims);

  let relWords = [];
  let newBase = 0;
  for (const r of ranges) {
    const rel = wordsInRange(transcript.words, r.start, r.end);
    for (const w of rel) relWords.push({ w: w.w, start: w.start + newBase, end: w.end + newBase });
    newBase += r.end - r.start;
  }
  // 語ではなく文節を最小単位にしてから、幅で詰める（語の途中で折れないようにする）。
  // 切れ目が1つも取れなかった場合は、従来どおり語のまま扱う（編集は止めない）。
  const units = groupIntoPhrases(relWords);
  const cards = fixDanglingCardTails(buildCaptionCards(units, budgetPx, fontSize), budgetPx, fontSize);
  const LEAD = 0.05;
  const MAXHOLD = 0.6;
  // 終了時刻は「次のカードの表示開始より前」を絶対条件にする（最低表示時間の底上げより優先。
  // 底上げを先に適用すると、間隔の詰まったカード同士で重なって縦に積み上がる事故が起きる）。
  const events = cards
    .map((c, i) => {
      const text = wrapCardText(c, budgetPx, fontSize).replace(/[{}]/g, "");
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
Style: Caption,${CAPTION_FONT.family},${fontSize},&H00FFFFFF,&H00000000,&H00000000,1,1,${outline},0,2,${marginLR},${marginLR},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  fs.writeFileSync(assPath, header + events.join("\n") + "\n", "utf-8");
}

/**
 * 【2026-08-19】以前はここで `drawbox=...color=black@1.0:t=fill` を敷いていた。
 * 画面下部 27.8%（1080p なら y=780 から 300px）を不透明の黒で塗り潰すもので、
 * 横型の出力では実際の映像の上に被さり、人物の胴体が黒帯で切れていた。
 * 帯は置かず、白文字＋黒縁だけで背景から字を切り離す（マスター決定 2026-08-19）。
 * 素材にすでに字幕が焼かれている動画では、その字幕が見えるようになるが、代替は作らない。
 */
function burnCaptions(inPath, assPath, outPath, workDir) {
  console.log("[8/8] 字幕を焼き込み中…");
  // ffmpeg の subtitles フィルタは Windows のドライブレター(C:)をオプション区切りと誤認するため、
  // 作業ディレクトリからの相対パスで渡す（絶対パスのコロンを回避する）。
  const relAss = path.relative(workDir, assPath).split(path.sep).join("/");
  const relFonts = path.relative(workDir, FONTS_DIR).split(path.sep).join("/");
  runSync(
    "ffmpeg",
    [
      "-y",
      "-i", inPath,
      "-vf", `subtitles=${relAss}:fontsdir=${relFonts}`,
      "-c:v", "libx264", "-crf", "18", "-preset", "medium",
      "-c:a", "copy",
      outPath,
    ],
    { cwd: workDir }
  );
}

// ---------- メイン ----------
//
// 【2026-08-19 マスター指示】「UIに素材を投げる→文字起こしする→お前が内容を決める→
// FFmpegで書き出し」にしろ。区間選定を別プロセスの claude -p（毎回まっさらな使い捨ての
// Opus5呼び出し）に丸投げしていたのが、意味の通らない断片を出す原因だった
// （「その名も、コズム」が「も、コズム」になる等。docs/failures.md 参照）。
// 「内容を決める」のはこのセッション（虎の巻・合格条件・過去の失敗を全部知っている）。
// 2コマンドに分割する:
//   node src/edit-job.mjs prepare <jobId>  文字起こし〜文節化まで（ワーカーが自動実行）
//   node src/edit-job.mjs render <jobId>   work/<jobId>/keep.json を読んで書き出しまで
//                                          （keep.json はこのセッションが直接書く）

/** prepare: 文字起こし・誤字修正・無音実測・文節化までを行い、判断材料を work/<jobId> に残す。 */
async function prepareMain(jobId) {
  const job = readInboxJob(jobId);
  const workDir = path.join(RUNTIME_DIR, "work", jobId);
  const outDir = path.join(RUNTIME_DIR, "outputs", jobId);
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  try {
    if (!job.video || !job.video.path) {
      throw new Error("このジョブには動画がありません（instructionのみのテスト送信の可能性）");
    }
    console.log(`[0/4] 受け取った指示: ${job.instruction ? job.instruction : "（指示なし）"}`);
    checkCancelled(workDir);
    transcribe(job.video.path, workDir);
    checkCancelled(workDir);
    console.log("[2/4] 台本の誤字を直しています（全体を読んでから直します）…");
    try {
      const r = await aiCaptionFixStage({
        workDir,
        runModel: createDefaultRunModel(workDir),
        onLog: (l) => console.log(`  ${l}`),
      });
      console.log(`  ${r.total} 語中 ${r.fixed} 語を直しました`);
    } catch (err) {
      console.log(`  誤字修正に失敗しました（そのまま続行します）: ${err.message}`);
    }
    checkCancelled(workDir);
    const transcript = JSON.parse(fs.readFileSync(path.join(workDir, "transcript.json"), "utf-8"));
    const silences = detectSilences(job.video.path);
    fs.writeFileSync(path.join(workDir, "silences.json"), `${JSON.stringify(silences, null, 2)}\n`, "utf-8");

    console.log("[4/4] 文節に分けています…");
    const units = groupIntoPhrases(transcript.words || []);
    fs.writeFileSync(
      path.join(workDir, "units.json"),
      `${JSON.stringify(
        units.map((u, i) => ({ i, start: +u.start.toFixed(3), end: +u.end.toFixed(3), w: u.w })),
        null,
        2
      )}\n`,
      "utf-8"
    );
    console.log(`  文節 ${units.length} 個。work/${jobId}/units.json を見て、keep.json を書いてください。`);
    console.log(`  終わったら: node src/edit-job.mjs render ${jobId}`);
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

/**
 * render: work/<jobId>/keep.json を読み、書き出しまで実行する。
 * keep.json の形式: {"keep": [[開始文節番号, 終了文節番号], ...],
 *                     "applied": ["反映した指示"], "notApplied": ["反映できなかった指示"]}
 * keep はこのセッションが units.json を読んで直接決める（区間選定の自動化はしない）。
 */
async function renderMain(jobId) {
  const job = readInboxJob(jobId);
  const workDir = path.join(RUNTIME_DIR, "work", jobId);
  const outDir = path.join(RUNTIME_DIR, "outputs", jobId);

  try {
    const unitsPath = path.join(workDir, "units.json");
    const keepPath = path.join(workDir, "keep.json");
    if (!fs.existsSync(unitsPath)) throw new Error(`prepare を先に実行してください: ${unitsPath} がありません`);
    if (!fs.existsSync(keepPath)) throw new Error(`keep.json がありません（このセッションが直接書きます）: ${keepPath}`);

    const units = JSON.parse(fs.readFileSync(unitsPath, "utf-8"));
    const silences = JSON.parse(fs.readFileSync(path.join(workDir, "silences.json"), "utf-8"));
    const transcript = JSON.parse(fs.readFileSync(path.join(workDir, "transcript.json"), "utf-8"));
    const keepDoc = JSON.parse(fs.readFileSync(keepPath, "utf-8"));
    if (!Array.isArray(keepDoc.keep) || keepDoc.keep.length === 0) {
      throw new Error("keep.json の keep 配列が空です");
    }

    const asLines = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === "string" && s.trim()) : []);
    const decision = {
      ranges: keepDoc.keep.map(([a, b]) => {
        const from = units[Math.min(a, b)];
        const to = units[Math.max(a, b)];
        if (!from || !to) throw new Error(`不正な文節番号: ${a}, ${b}`);
        return { start: from.start, end: to.end };
      }),
      applied: asLines(keepDoc.applied),
      notApplied: asLines(keepDoc.notApplied),
    };

    checkCancelled(workDir);
    let ranges = snapRanges(decision.ranges, silences, groupIntoPhrases(transcript.words || []));

    console.log("[5/8] 言い淀みを切っています…");
    const fillerPlan = planFillerCuts(transcript.words || [], silences);
    if (fillerPlan.aborted) {
      console.log("  フィラー判定が半数を超えたため、判定が壊れているとみなして1つも切りません");
    } else {
      ranges = subtractCuts(ranges, fillerPlan.cuts);
      const cutSec = fillerPlan.cuts.reduce((a, c) => a + (c.end - c.start), 0);
      console.log(`  ${fillerPlan.cuts.length}箇所 / 計${cutSec.toFixed(1)}秒を除去（見送り ${fillerPlan.skipped.length}箇所）`);
      for (const c of fillerPlan.cuts) console.log(`    切: ${c.start.toFixed(2)}s 「${c.word}」`);
      for (const k of fillerPlan.skipped) console.log(`    残: ${k.start.toFixed(2)}s 「${k.word}」← ${k.reason}`);
    }
    decision.fillerCuts = fillerPlan.cuts;
    decision.fillerSkipped = fillerPlan.skipped;
    fs.writeFileSync(
      path.join(workDir, "decision.json"),
      `${JSON.stringify({ instruction: job.instruction ?? "", ...decision, ranges }, null, 2)}\n`,
      "utf-8"
    );
    for (const line of decision.applied) console.log(`  [反映] ${line}`);
    for (const line of decision.notApplied) console.log(`  [未反映] ${line}`);
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
      burnCaptions(framedPath, assPath, resultPath, workDir);
    } else {
      fs.copyFileSync(framedPath, resultPath);
    }

    console.log("[完了] 完了記録を書き込み中…");
    appendResult({
      id: jobId,
      status: "done",
      output: resultPath,
      instruction: job.instruction ?? "",
      applied: decision.applied,
      notApplied: decision.notApplied,
      at: new Date().toISOString(),
    });
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

async function main() {
  const [, , cmd, jobId] = process.argv;
  if (!cmd || !jobId || (cmd !== "prepare" && cmd !== "render")) usage();
  if (cmd === "prepare") await prepareMain(jobId);
  else await renderMain(jobId);
}

// 検証スクリプト等からこのファイルを import して buildCaptionCards/wrapCardText/buildAssFile を
// 単体で叩けるように、直接実行されたときだけ main() を走らせる。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
