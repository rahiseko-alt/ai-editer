// D2: 概算UI（apps/web/app/estimate）の状態→表示ロジック。
// D1（lib/estimate.ts）の純関数を、フォーム入力の生の状態から呼び出す薄い変換層。
// UI側はこの結果をそのまま描画するだけにし、DOM非依存でテストできるようここへ分離する。

import {
  type EstimateInput,
  type EstimateResult,
  type RecalcResult,
  type ScopeChange,
  type ThreePoint,
  estimate,
  recalcWithChange,
} from "./estimate";

/** フォームの生入力（すべて編集中の状態として保持する）。 */
export interface EstimateFormState {
  effort: ThreePoint;
  /** 未入力は null（コスト/期間はオプション出力のため）。 */
  dayRate: number | null;
  capacityPerDay: number | null;
  /** 要件変更。未入力（追加/削減を検討していない）は null。 */
  scopeChange: ScopeChange | null;
}

/** 画面に出す結果。バリデーション失敗時は result/recalc を持たず error のみ。 */
export interface EstimateView {
  result: EstimateResult | null;
  recalc: RecalcResult | null;
  error: string | null;
}

export const INITIAL_FORM_STATE: EstimateFormState = {
  effort: { optimistic: 2, mostLikely: 4, pessimistic: 12 },
  dayRate: null,
  capacityPerDay: null,
  scopeChange: null,
};

/**
 * 入力欄の編集中の生テキスト（ThreePoint の各項目を文字列で保持する）。
 * 数値へは deriveEstimateView に渡す直前まで変換しない。ここで即数値化して
 * フォールバックすると、空欄化や負値・小数の入力途中（"-" や ""）が
 * 直前の値に押し戻され、編集不能になるため。
 */
export interface ThreePointDraft {
  optimistic: string;
  mostLikely: string;
  pessimistic: string;
}

/** 空文字は NaN にする（Number("") は 0 になり空欄と 0 を区別できないため）。 */
function parseDraftNumber(raw: string): number {
  return raw.trim() === "" ? NaN : Number(raw);
}

/** 編集中のテキストを ThreePoint（数値）へ変換する。不正な値は NaN のまま返し、判定は estimate.ts に委ねる。 */
export function draftToThreePoint(draft: ThreePointDraft): ThreePoint {
  return {
    optimistic: parseDraftNumber(draft.optimistic),
    mostLikely: parseDraftNumber(draft.mostLikely),
    pessimistic: parseDraftNumber(draft.pessimistic),
  };
}

/** ThreePoint を編集用テキストへ変換する（初期値の表示用）。 */
export function threePointToDraft(point: ThreePoint): ThreePointDraft {
  return {
    optimistic: String(point.optimistic),
    mostLikely: String(point.mostLikely),
    pessimistic: String(point.pessimistic),
  };
}

/** 空欄は「未入力」として null（オプション項目 dayRate/capacityPerDay 用）。 */
export function parseOptionalNumberDraft(raw: string): number | null {
  return raw.trim() === "" ? null : Number(raw);
}

function buildInput(state: EstimateFormState): EstimateInput {
  const input: EstimateInput = { effort: state.effort };
  if (state.dayRate !== null) input.dayRate = state.dayRate;
  if (state.capacityPerDay !== null) input.capacityPerDay = state.capacityPerDay;
  return input;
}

/**
 * フォーム状態から表示用の見積り結果を導出する。
 * 要件変更(scopeChange)が入力されていれば再計算(before/after/delta)を、
 * なければ単発の見積りを返す。estimate.ts の RangeError は画面向けエラー文言に変換する。
 */
export function deriveEstimateView(state: EstimateFormState): EstimateView {
  const input = buildInput(state);
  try {
    if (state.scopeChange) {
      const recalc = recalcWithChange(input, state.scopeChange);
      return { result: null, recalc, error: null };
    }
    const result = estimate(input);
    return { result, recalc: null, error: null };
  } catch (err) {
    const message = err instanceof RangeError ? err.message : "入力値を計算できませんでした。";
    return { result: null, recalc: null, error: message };
  }
}
