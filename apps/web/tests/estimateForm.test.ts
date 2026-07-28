import { describe, expect, it } from "vitest";

import {
  INITIAL_FORM_STATE,
  deriveEstimateView,
  draftToThreePoint,
  parseOptionalNumberDraft,
  threePointToDraft,
  type EstimateFormState,
} from "../lib/estimateForm";

// D2 の実テスト（echo/ダミーではない代表ケース）。
// 「入力に対し即時に結果が反映される」の中核＝状態→表示の変換ロジックを、
// DOMなしで検証する（interactionはブラウザ/リモート実演側で検証）。

describe("deriveEstimateView: 単発の見積り", () => {
  it("初期状態は工数レンジを返す（コスト・期間はオプション未指定なので無し）", () => {
    const view = deriveEstimateView(INITIAL_FORM_STATE);
    expect(view.error).toBeNull();
    expect(view.recalc).toBeNull();
    expect(view.result?.effort.expected).toBe(5); // (2 + 4*4 + 12) / 6
    expect(view.result?.cost).toBeUndefined();
    expect(view.result?.period).toBeUndefined();
  });

  it("dayRate/capacityPerDay を入れるとコスト・期間も返る", () => {
    const state: EstimateFormState = {
      ...INITIAL_FORM_STATE,
      dayRate: 50000,
      capacityPerDay: 2,
    };
    const view = deriveEstimateView(state);
    expect(view.error).toBeNull();
    expect(view.result?.cost?.expected).toBe(250000);
    expect(view.result?.period?.expected).toBe(2.5);
  });

  it("optimistic > mostLikely 等の不整合は例外を投げずエラー文言で返す", () => {
    const state: EstimateFormState = {
      ...INITIAL_FORM_STATE,
      effort: { optimistic: 10, mostLikely: 4, pessimistic: 12 },
    };
    const view = deriveEstimateView(state);
    expect(view.result).toBeNull();
    expect(view.recalc).toBeNull();
    expect(view.error).toMatch(/optimistic ≤ mostLikely ≤ pessimistic/);
  });
});

describe("deriveEstimateView: 要件変更→即時再計算", () => {
  it("scopeChange が入力されると result ではなく recalc(before/after/delta) を返す", () => {
    const state: EstimateFormState = {
      ...INITIAL_FORM_STATE,
      scopeChange: { kind: "add", effort: { optimistic: 1, mostLikely: 2, pessimistic: 3 } },
    };
    const view = deriveEstimateView(state);
    expect(view.error).toBeNull();
    expect(view.result).toBeNull();
    expect(view.recalc?.before.effort.expected).toBe(5);
    expect(view.recalc?.after.effort.expected).toBe(7); // (3 + 4*6 + 15) / 6
    expect(view.recalc?.deltaEffort).toBe(2);
  });

  it("削減方向の要件変更は差分が負になる", () => {
    const state: EstimateFormState = {
      ...INITIAL_FORM_STATE,
      scopeChange: { kind: "remove", effort: { optimistic: 1, mostLikely: 1, pessimistic: 1 } },
    };
    const view = deriveEstimateView(state);
    expect(view.recalc?.deltaEffort).toBeLessThan(0);
  });
});

// CodeRabbit指摘（PR#13）の再発防止：入力欄を空にした/負値を打ち始めた際に
// 直前の値へ押し戻される（Number("")===0, Number("-")===NaN でフォールバックしていた）
// 事故が無いことを、DOM無しで draft⇄ThreePoint 変換の単体テストとして固定する。
describe("draftToThreePoint / threePointToDraft / parseOptionalNumberDraft", () => {
  it("空文字は 0 ではなく NaN になる（Number('')===0 に丸められない）", () => {
    const point = draftToThreePoint({ optimistic: "", mostLikely: "4", pessimistic: "12" });
    expect(point.optimistic).toBeNaN();
  });

  it("空欄のまま deriveEstimateView に渡すと、直前値への差し戻しではなくエラーになる", () => {
    const state: EstimateFormState = {
      ...INITIAL_FORM_STATE,
      effort: draftToThreePoint({ optimistic: "", mostLikely: "4", pessimistic: "12" }),
    };
    const view = deriveEstimateView(state);
    expect(view.result).toBeNull();
    expect(view.error).toMatch(/有限の数値/);
  });

  it("小数・負の入力途中('-'単体)も NaN として扱われ、サイレントに丸められない", () => {
    expect(draftToThreePoint({ optimistic: "1.5", mostLikely: "2", pessimistic: "3" }).optimistic).toBe(
      1.5,
    );
    expect(draftToThreePoint({ optimistic: "-", mostLikely: "2", pessimistic: "3" }).optimistic).toBeNaN();
  });

  it("threePointToDraft は draftToThreePoint の逆変換になる（往復一致）", () => {
    const original = { optimistic: 1.5, mostLikely: 2, pessimistic: 3 };
    expect(draftToThreePoint(threePointToDraft(original))).toEqual(original);
  });

  it("parseOptionalNumberDraft は空文字を null、それ以外は数値にする", () => {
    expect(parseOptionalNumberDraft("")).toBeNull();
    expect(parseOptionalNumberDraft("  ")).toBeNull();
    expect(parseOptionalNumberDraft("50000")).toBe(50000);
  });
});
