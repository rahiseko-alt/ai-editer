// tests/trim-judge-multiclip-check.mjs — G-TRIM2-CLIP
//
// 【直した欠陥】2本目以降のクリップで、trim-judge.json の判断（AI が「消してよい／詰めてよい」
// と答えた語・間）が正しく引き当てられていなかった。
//   (1) 誤カット: loadTrimJudge() が語を**表記**で引き当てていた(indexOfWord)ため、
//       素材の先頭に出た同じ表記の語の判定が、2本目以降のクリップでも使われた
//       （先頭の「あの」が言い淀みなら、後半の「あの資料を」も消えた）。
//   (2) 無音が一切詰まらない: cutSilence が「詰めてよい間」を素材の絶対時刻で持っていたが、
//       planTrim に渡る語はクリップ相対時刻へ変換済みだったため、segStart>0 のクリップでは
//       絶対時刻とクリップ相対時刻が一致せず、実質つねに false になっていた
//       （外部レビューは「cutSilence は既に時刻ベースなので isFiller をそれに揃えよ」と
//        書いていたが、その cutSilence 自身も壊れていた）。
//
// 【直し方】語ごとの「素材全体で何番目か（絶対添字）」を、クリップの切り出しとは独立に
// indexesInRange() で求め、各語オブジェクトへ _absIndex として持たせてから planTrim へ渡す。
// judge（trim-judge.mjs の judgeFor()）は絶対添字だけを見て判定するので、時刻の突き合わせも
// 表記の突き合わせも行わない。
//
// 【固定素材】tests/fixtures/trim-judge/case-b-multiclip.json
//   全長26.0秒・30fps・全時刻が0.1秒(3コマ)の倍数（丸めが結果に影響しない）。
//   クリップ1=[0.0,5.0](segStart=0) / クリップ2=[10.0,24.0](segStart=10.0)。
//   境界値: 「あの」はクリップ1で言い淀み・クリップ2では指示語（逆の役割）。
//           「その」はクリップ1で指示語・クリップ2では言い淀み（逆の役割）。
//   クリップ2の先頭の語(idx4「えーと」)はクリップの左境界(10.0)を跨ぐ(9.7〜10.3)。
//
// 【対照】旧実装（語の表記で引き当てる版）を本ファイル内で実際に再現し(oldStyleJudge)、
// 同じ固定素材・同じ現行の planTrim（区間の作り方そのものは変えていない）へ通して、
// 期待どおり壊れた値になることを実測する（同語反復にしない）。
//
// 【許容差】秒は ±0.01秒（両端を含む）。素材の全時刻・期待値が0.1秒刻みで作ってあり、
//   fps=30（0.1秒=3コマ）なので丸めは一切発生しない。何の揺れも吸収する必要が無いため、
//   浮動小数の計算誤差だけを許容する幅として ±0.01秒を置く。
//
// 実行: node tests/trim-judge-multiclip-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { indexesInRange, wordsInRange } from "../src/srt-builder.mjs";
import { judgeFor } from "../src/trim-judge.mjs";
import { planTrim } from "../src/trim-plan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOL = 0.01;
const FPS = 30;

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(HERE, "fixtures", "trim-judge", "case-b-multiclip.json"), "utf-8"),
);
const ALL_WORDS = FIXTURE.words.map((w) => ({ w: w.w, start: w.start, end: w.end }));

let pass = 0,
  fail = 0;
function report(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

/** keep 区間群と [a,b] の重なりの長さ（秒）。 */
function overlap(keep, a, b) {
  return keep.reduce((acc, k) => acc + Math.max(0, Math.min(k.end, b) - Math.max(k.start, a)), 0);
}

/**
 * このクリップを、現行実装（indexesInRange + judgeFor）で計画する。
 * pipeline.mjs の renderSegment と同じ手順（_absIndex を語へ持たせてから planTrim へ渡す）。
 */
function planClip(clip) {
  const absIndexes = indexesInRange(ALL_WORDS, clip.start, clip.end);
  const relWords = wordsInRange(ALL_WORDS, clip.start, clip.end).map((w, i) => ({
    ...w,
    _absIndex: absIndexes[i],
  }));
  const judge = judgeFor({
    fillers: new Set(FIXTURE.trimJudge.fillers),
    cutGaps: new Set(FIXTURE.trimJudge.cutGaps),
  });
  return planTrim(relWords, {
    duration: clip.end - clip.start,
    fps: FPS,
    cutSilence: true,
    cutFillers: true,
    judge,
  });
}

/**
 * 旧実装（2026-08-16以前の src/trim-judge.mjs）を再現した judge。
 * 語を**表記**で引き当てる(indexOfWord相当)。呼ばれた回数を「list内の位置」として使う
 * （旧 trim-plan.mjs は idx=list内の位置をそのまま judge.isFiller の第1引数へ渡していたため）。
 * cutSilence は「詰めてよい間」を絶対時刻(cutEnds)で持ち、渡された時刻とだけ比べる
 * （クリップ相対か絶対かを区別しない＝これが(2)の欠陥そのもの）。
 */
function oldStyleJudge(allWords, fillerIdxArr, cutGapIdxArr) {
  const fillerSet = new Set(fillerIdxArr);
  const cutEnds = new Set(
    cutGapIdxArr
      .map((i) => (allWords[i] ? Number(allWords[i].end.toFixed(3)) : null))
      .filter((v) => v !== null),
  );
  let callCount = 0;
  return {
    isFiller: (_absIndexIgnoredByOldCode, word) => {
      const hint = callCount;
      callCount += 1;
      const idx =
        allWords[hint] && allWords[hint].w === word ? hint : allWords.findIndex((w) => w.w === word);
      return fillerSet.has(idx);
    },
    cutSilence: (start) => cutEnds.has(Number(start.toFixed(3))),
  };
}

function planClipOldStyle(clip) {
  const relWords = wordsInRange(ALL_WORDS, clip.start, clip.end);
  const judge = oldStyleJudge(ALL_WORDS, FIXTURE.trimJudge.fillers, FIXTURE.trimJudge.cutGaps);
  return planTrim(relWords, {
    duration: clip.end - clip.start,
    fps: FPS,
    cutSilence: true,
    cutFillers: true,
    judge,
  });
}

/** keep+cuts の区間群が [0,duration] を隙間なく・重なりなく覆っているか。 */
function checkConservation(plan, duration) {
  const spans = [
    ...plan.keep.map((s) => ({ start: s.start, end: s.end })),
    ...plan.cuts.map((s) => ({ start: s.start, end: s.end })),
  ].sort((a, b) => a.start - b.start);
  if (spans.length === 0) return duration <= 1e-6;
  if (Math.abs(spans[0].start - 0) > 1e-6) return false;
  for (let i = 0; i < spans.length; i++) {
    if (spans[i].end <= spans[i].start) return false;
    if (i > 0 && Math.abs(spans[i].start - spans[i - 1].end) > 1e-6) return false; // 隙間 or 重なり
  }
  return Math.abs(spans[spans.length - 1].end - duration) <= 1e-6;
}

/* ══════ 現行実装（正しい引き当て） ══════ */

const planC1 = planClip(FIXTURE.clip1);
const planC2 = planClip(FIXTURE.clip2);

report(
  "G-TRIM2-CLIP-COMPAT-CLIP1: 先頭のクリップ(segStart=0)の残り時間は従来どおり4.5秒",
  Math.abs(planC1.keptSeconds - FIXTURE.expected.clip1KeptSeconds) <= TOL,
  `実測=${planC1.keptSeconds} 期待=${FIXTURE.expected.clip1KeptSeconds}`,
);

report(
  "G-TRIM2-CLIP-WIRED相当: 2本目のクリップの残り時間が10.9秒になる（現行のバグでは13.2秒）",
  Math.abs(planC2.keptSeconds - FIXTURE.expected.clip2KeptSeconds) <= TOL,
  `実測=${planC2.keptSeconds} 期待=${FIXTURE.expected.clip2KeptSeconds}`,
);

report(
  "G-TRIM2-CLIP-FILLER-KEEP: 2本目のクリップの指示語「あの」(1.3-1.8)が消えずに残る",
  Math.abs(
    overlap(planC2.keep, 1.3, 1.8) - FIXTURE.expected.clip2Windows.fillerKeepResidual,
  ) <= TOL,
  `残り=${overlap(planC2.keep, 1.3, 1.8)}（期待 0.5＝まるごと残る）`,
);

report(
  "G-TRIM2-CLIP-FILLER-CUT: 2本目のクリップの言い淀み「その」(11.3-11.8)がちゃんと消える",
  Math.abs(
    overlap(planC2.keep, 11.3, 11.8) - FIXTURE.expected.clip2Windows.fillerCutResidual,
  ) <= TOL,
  `残り=${overlap(planC2.keep, 11.3, 11.8)}（期待 0.0＝消える）`,
);

report(
  "G-TRIM2-CLIP-SILENCE-CUT: 2本目のクリップの「詰めてよい間」(3.3-6.3)が余韻0.7秒まで詰まる（3.0秒の間なので clamp(0.75,0.3,0.7)）",
  Math.abs(
    overlap(planC2.keep, 3.3, 6.3) - FIXTURE.expected.clip2Windows.silenceCutResidual,
  ) <= TOL,
  `残り=${overlap(planC2.keep, 3.3, 6.3)}（期待 0.3）`,
);

report(
  "G-TRIM2-CLIP-SILENCE-KEEP: 2本目のクリップの「会話の途中の沈黙」(7.3-9.3)は1秒も詰まらない",
  Math.abs(
    overlap(planC2.keep, 7.3, 9.3) - FIXTURE.expected.clip2Windows.silenceKeepResidual,
  ) <= TOL,
  `残り=${overlap(planC2.keep, 7.3, 9.3)}（期待 2.0＝まるごと残る）`,
);

report(
  "G-TRIM2-CLIP-STRADDLE: クリップの左境界(10.0)を跨ぐ語(9.7-10.3)の言い淀み判定が正しい",
  Math.abs(
    overlap(planC2.keep, 0.0, 0.3) - FIXTURE.expected.clip2Windows.straddleResidual,
  ) <= TOL,
  `残り=${overlap(planC2.keep, 0.0, 0.3)}（期待 0.0＝正しく言い淀みとして消える）`,
);

report(
  "G-TRIM2-CLIP-CONSERVE: 残した所と切った所を足すと、2本目のクリップの元の長さ(14.0秒)にぴったり戻る",
  checkConservation(planC2, 14.0),
  `keep=${JSON.stringify(planC2.keep)} cuts=${JSON.stringify(planC2.cuts)}`,
);

report(
  "G-TRIM2-CLIP-CONSERVE（クリップ1）: 同じく1本目のクリップでも取りこぼしが無い",
  checkConservation(planC1, 5.0),
);

/* ══════ 対照: 旧実装（語の表記で引き当てる）を実際に実行する ══════ */

const oldC1 = planClipOldStyle(FIXTURE.clip1);
const oldC2 = planClipOldStyle(FIXTURE.clip2);

report(
  "対照: 旧実装は先頭のクリップ(segStart=0)では偶然正しく動く（4.5秒）",
  Math.abs(oldC1.keptSeconds - FIXTURE.brokenExpected.clip1KeptSeconds) <= TOL,
  `実測=${oldC1.keptSeconds}`,
);

report(
  "対照: 旧実装は2本目のクリップで13.2秒になる（本来の10.9秒より2.3秒多く残る＝壊れている）",
  Math.abs(oldC2.keptSeconds - FIXTURE.brokenExpected.clip2KeptSeconds) <= TOL,
  `実測=${oldC2.keptSeconds} 期待(壊れた値)=${FIXTURE.brokenExpected.clip2KeptSeconds}`,
);

report(
  "対照: 旧実装は指示語「あの」(1.3-1.8)を誤って消す（先頭の言い淀み「あの」と表記が同じため）",
  Math.abs(
    overlap(oldC2.keep, 1.3, 1.8) - FIXTURE.brokenExpected.clip2Windows.fillerKeepResidual,
  ) <= TOL,
  `残り=${overlap(oldC2.keep, 1.3, 1.8)}（旧実装は0.0＝誤って消える）`,
);

report(
  "対照: 旧実装は言い淀み「その」(11.3-11.8)を誤って残す（クリップ1の指示語「その」と表記が同じため）",
  Math.abs(
    overlap(oldC2.keep, 11.3, 11.8) - FIXTURE.brokenExpected.clip2Windows.fillerCutResidual,
  ) <= TOL,
  `残り=${overlap(oldC2.keep, 11.3, 11.8)}（旧実装は0.5＝誤って残る）`,
);

report(
  "対照: 旧実装は2本目のクリップの無音を一切詰めない（絶対時刻とクリップ相対時刻を比べているため）",
  Math.abs(
    overlap(oldC2.keep, 3.3, 6.3) - FIXTURE.brokenExpected.clip2Windows.silenceCutResidual,
  ) <= TOL,
  `残り=${overlap(oldC2.keep, 3.3, 6.3)}（旧実装は3.0＝1秒も詰まらない）`,
);

/* ══════ G-TRIM2-CLIP-ONEDOOR: 配線ミスは黙って退避せず例外にする ══════ */

report(
  "G-TRIM2-CLIP-ONEDOOR: loadTrimJudge() の生データをそのまま渡すと例外になる（配線ミスの検知）",
  (() => {
    try {
      planTrim(wordsInRange(ALL_WORDS, FIXTURE.clip2.start, FIXTURE.clip2.end), {
        duration: 14.0,
        judge: { fillers: new Set([0]), cutGaps: new Set([1]) }, // judgeFor() を通していない生データ
      });
      return false; // 例外にならなかった＝失敗
    } catch (e) {
      return /isFiller|cutSilence/.test(e.message);
    }
  })(),
);

report(
  "G-TRIM2-CLIP-ONEDOOR 対照: judgeFor() を正しく通した judge は例外にならない",
  (() => {
    try {
      const relWords = wordsInRange(ALL_WORDS, FIXTURE.clip2.start, FIXTURE.clip2.end);
      planTrim(relWords, {
        duration: 14.0,
        judge: judgeFor({ fillers: new Set([0]), cutGaps: new Set([1]) }),
      });
      return true;
    } catch (_) {
      return false;
    }
  })(),
);

report(
  "G-TRIM2-CLIP-ONEDOOR 対照: judge を渡さない（null）のは正当な後方互換で、例外にならない",
  (() => {
    try {
      const relWords = wordsInRange(ALL_WORDS, FIXTURE.clip1.start, FIXTURE.clip1.end);
      planTrim(relWords, { duration: 5.0 });
      return true;
    } catch (_) {
      return false;
    }
  })(),
);

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
