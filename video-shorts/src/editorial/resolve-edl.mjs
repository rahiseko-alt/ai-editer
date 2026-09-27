// video-shorts src/editorial/resolve-edl.mjs — 編集案（文節番号）を、書き出し用の EDL（秒）へ直す。
//
// ここは判断をしない。やるのは決定論的な変換だけ:
//   1. 文節番号 → 文字起こし上の時刻（units.json の start/end）
//   2. 無音スナップ（boundary.mjs。捨てると決めた隣の文節は越えない）
//   3. 言い淀みの除去（filler-cut.mjs。1区間が複数の破片に分かれることがある）
// 同じ入力からは常に同じ EDL が出る。書き出し（renderFinal）は EDL だけを見る。
//
// EDL（edl.json, version 2）:
//   {
//     "version": 2,
//     "source": "<元動画のパス>",
//     "ranges": [ { "start": 12.382, "end": 18.744, "segment": 0, "fromUnit": 12, "toUnit": 18, "role": "HOOK" }, ... ],
//     "fillerCuts": [...], "fillerSkipped": [...], "fillerAborted": false,
//     "options": { "noSnap": false, "noFiller": false }
//   }
// ranges の並び順が動画での順番。1つの segment から複数の range が出ることがある（言い淀み除去）。

import { planFillerCuts, subtractCuts } from "../filler-cut.mjs";
import { groupIntoPhrases } from "../script/phrases.mjs";
import { snapRanges } from "./boundary.mjs";

/**
 * @param {{plan:object, units:{start:number,end:number}[], silences:{start:number,end:number}[],
 *   words:{w:string,start:number,end:number}[], source:string, noSnap?:boolean, noFiller?:boolean}} args
 */
export function resolveEdl({ plan, units, silences, words, source, noSnap = false, noFiller = false }) {
  const raw = plan.segments.map((seg) => ({ start: units[seg.fromUnit].start, end: units[seg.toUnit].end }));
  const snapped = noSnap ? raw : snapRanges(raw, silences, groupIntoPhrases(words, silences));

  const filler = noFiller ? { cuts: [], skipped: [], aborted: false } : planFillerCuts(words, silences);
  const cuts = filler.aborted ? [] : filler.cuts;

  const ranges = [];
  snapped.forEach((r, i) => {
    const seg = plan.segments[i];
    for (const piece of subtractCuts([r], cuts)) {
      ranges.push({
        start: piece.start,
        end: piece.end,
        segment: i,
        fromUnit: seg.fromUnit,
        toUnit: seg.toUnit,
        ...(seg.role ? { role: seg.role } : {}),
      });
    }
  });

  return {
    version: 2,
    source,
    ranges,
    fillerCuts: filler.cuts,
    fillerSkipped: filler.skipped,
    fillerAborted: filler.aborted,
    options: { noSnap, noFiller },
  };
}
