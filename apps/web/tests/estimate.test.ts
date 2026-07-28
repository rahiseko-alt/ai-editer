import { describe, expect, it } from "vitest";

import {
  CONE_FACTORS,
  coneRange,
  combineThreePoint,
  confidenceOf,
  estimate,
  pertExpected,
  pertStdDev,
  recalcWithChange,
  type ThreePoint,
} from "../lib/estimate";

// 概算エンジン D1 の実テスト（echo/ダミーではない代表ケース）。
// A3 DP-6「点でなく幅＋信頼度」「要件変更→工数の再計算」を期待値一致で検証する。

const SAMPLE: ThreePoint = { optimistic: 2, mostLikely: 4, pessimistic: 12 };

describe("PERT 三点見積り", () => {
  it("期待値は (O + 4M + P) / 6", () => {
    // (2 + 16 + 12) / 6 = 5
    expect(pertExpected(SAMPLE)).toBe(5);
  });

  it("標準偏差は (P - O) / 6", () => {
    // (12 - 2) / 6 = 1.6667
    expect(pertStdDev(SAMPLE)).toBeCloseTo(1.6667, 4);
  });

  it("O ≤ M ≤ P を破る入力は例外", () => {
    expect(() => pertExpected({ optimistic: 5, mostLikely: 4, pessimistic: 12 })).toThrow(
      /optimistic ≤ mostLikely ≤ pessimistic/,
    );
  });

  it("負値は例外", () => {
    expect(() => pertExpected({ optimistic: -1, mostLikely: 4, pessimistic: 12 })).toThrow(
      /0 以上/,
    );
  });
});

describe("estimate: 工数・コスト・期間をレンジで返す", () => {
  it("工数レンジは low=O, high=P, expected=PERT", () => {
    const r = estimate({ effort: SAMPLE });
    expect(r.effort.low).toBe(2);
    expect(r.effort.high).toBe(12);
    expect(r.effort.expected).toBe(5);
    expect(r.cost).toBeUndefined();
    expect(r.period).toBeUndefined();
  });

  it("dayRate があればコストを工数レンジに比例して出す", () => {
    const r = estimate({ effort: SAMPLE, dayRate: 50000 });
    expect(r.cost).toBeDefined();
    expect(r.cost?.expected).toBe(250000); // 5 * 50000
    expect(r.cost?.low).toBe(100000); // 2 * 50000
    expect(r.cost?.high).toBe(600000); // 12 * 50000
  });

  it("capacityPerDay があれば期間（暦日）を出す", () => {
    const r = estimate({ effort: SAMPLE, capacityPerDay: 0.5 });
    expect(r.period?.expected).toBe(10); // 5 / 0.5
    expect(r.period?.low).toBe(4); // 2 / 0.5
    expect(r.period?.high).toBe(24); // 12 / 0.5
  });

  it("capacityPerDay=0 は例外（ゼロ除算を防ぐ）", () => {
    expect(() => estimate({ effort: SAMPLE, capacityPerDay: 0 })).toThrow(/正の有限数/);
  });
});

describe("信頼度（変動係数から導出）", () => {
  it("幅が広い（cv≈0.33）ケースは low", () => {
    const r = estimate({ effort: SAMPLE });
    expect(r.confidence).toBe("low");
  });

  it("幅が狭いケースは high", () => {
    // O=9, M=10, P=11 → expected=10, stdDev=0.3333, cv=0.033 < 0.1
    const r = estimate({ effort: { optimistic: 9, mostLikely: 10, pessimistic: 11 } });
    expect(r.confidence).toBe("high");
  });

  it("中間の幅は medium", () => {
    // O=8, M=10, P=13 → expected=(8+40+13)/6=10.1667, stdDev=0.8333, cv≈0.082 ... 調整
    // O=7, M=10, P=14 → expected=(7+40+14)/6=10.1667, stdDev=1.1667, cv≈0.115 → medium
    const r = estimate({ effort: { optimistic: 7, mostLikely: 10, pessimistic: 14 } });
    expect(r.confidence).toBe("medium");
  });

  it("ゼロ工数は high（幅もゼロ＝確実）", () => {
    expect(
      confidenceOf({ expected: 0, low: 0, high: 0, stdDev: 0 }),
    ).toBe("high");
  });
});

describe("Cone of Uncertainty", () => {
  it("初期段階は約 ±4倍の幅", () => {
    const r = coneRange(10, "initial");
    expect(r.low).toBe(2.5); // 10 * 0.25
    expect(r.high).toBe(40); // 10 * 4.0
  });

  it("設計確定段階は幅が縮む", () => {
    const r = coneRange(10, "designDone");
    expect(r.low).toBe(8); // 10 * 0.8
    expect(r.high).toBe(12.5); // 10 * 1.25
  });

  it("段階が進むほど幅（high-low）は単調に縮む", () => {
    const width = (p: keyof typeof CONE_FACTORS) => {
      const r = coneRange(10, p);
      return r.high - r.low;
    };
    expect(width("initial")).toBeGreaterThan(width("roughPlan"));
    expect(width("roughPlan")).toBeGreaterThan(width("requirementsDone"));
    expect(width("requirementsDone")).toBeGreaterThan(width("designDone"));
  });
});

describe("要件変更 → 工数の再計算（D の中核）", () => {
  it("付け足し（機能追加）で期待工数が増える", () => {
    // base {2,4,12}=5 に add {1,2,3} → {3,6,15}=(3+24+15)/6=7
    const res = recalcWithChange(
      { effort: SAMPLE },
      { kind: "add", effort: { optimistic: 1, mostLikely: 2, pessimistic: 3 } },
    );
    expect(res.before.effort.expected).toBe(5);
    expect(res.after.effort.expected).toBe(7);
    expect(res.deltaEffort).toBe(2);
  });

  it("削減で期待工数が減り、0 で下限クランプされる", () => {
    const combined = combineThreePoint(
      { optimistic: 1, mostLikely: 2, pessimistic: 3 },
      { kind: "remove", effort: { optimistic: 5, mostLikely: 5, pessimistic: 5 } },
    );
    expect(combined).toEqual({ optimistic: 0, mostLikely: 0, pessimistic: 0 });
  });

  it("コスト・期間も変更後の工数に追随する", () => {
    const res = recalcWithChange(
      { effort: SAMPLE, dayRate: 50000, capacityPerDay: 0.5 },
      { kind: "add", effort: { optimistic: 1, mostLikely: 2, pessimistic: 3 } },
    );
    expect(res.after.cost?.expected).toBe(350000); // 7 * 50000
    expect(res.after.period?.expected).toBe(14); // 7 / 0.5
  });
});
