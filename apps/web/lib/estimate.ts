// 概算エンジン（ロードマップ葉 D1）。
// 設計根拠は A3 設計原則集の DP-6「見積りは"点"でなく"幅＋信頼度"で出す」
// （出典：Boehm『COCOMO II』／McConnell『Software Estimation』／PERT）。
// 中核能力は3つ：
//   1. 三点/PERT 見積り（楽観 O・最頻 M・悲観 P → 期待値と幅）
//   2. Cone of Uncertainty（段階が進むほど不確実性の幅が縮む）
//   3. 要件変更 → 工数の即時再計算（付け足し／削減をレンジごと反映）
// すべて純関数。UI（D2）や公開到達（D3）はこのエンジンを土台にする。

/** 三点見積り（person-day 等の同一単位）。O ≤ M ≤ P を満たすこと。 */
export interface ThreePoint {
  /** 楽観値 optimistic */
  optimistic: number;
  /** 最頻値 most likely */
  mostLikely: number;
  /** 悲観値 pessimistic */
  pessimistic: number;
}

/** レンジ（点でなく幅＋バラつき）で表した見積り結果。 */
export interface Range {
  /** PERT 期待値 (O + 4M + P) / 6 */
  expected: number;
  /** 下限（＝楽観側） */
  low: number;
  /** 上限（＝悲観側） */
  high: number;
  /** PERT 標準偏差 (P - O) / 6 */
  stdDev: number;
}

/** 見積りの信頼度ラベル（相対バラつき=変動係数から導出）。 */
export type Confidence = "low" | "medium" | "high";

/**
 * Cone of Uncertainty の段階。プロジェクトが進むほど不確実性（幅）が縮む。
 * 係数は McConnell/Boehm の代表値（初期は約 ±4倍、要件確定で ±1.5倍、設計確定で約 ±1.25倍）。
 */
export type ConePhase =
  | "initial" // 着想時
  | "roughPlan" // 概略計画
  | "requirementsDone" // 要件確定
  | "designDone"; // 設計確定

/** Cone of Uncertainty の低/高係数（期待値に掛けて幅を作る）。 */
export const CONE_FACTORS: Record<ConePhase, { low: number; high: number }> = {
  initial: { low: 0.25, high: 4.0 },
  roughPlan: { low: 0.5, high: 2.0 },
  requirementsDone: { low: 0.67, high: 1.5 },
  designDone: { low: 0.8, high: 1.25 },
};

/** 概算エンジンへの入力。 */
export interface EstimateInput {
  /** 工数の三点見積り（person-day） */
  effort: ThreePoint;
  /** 1 person-day あたりの単価（コストを出す場合） */
  dayRate?: number;
  /** チームの1暦日あたり消化能力（person-day/日。期間を出す場合） */
  capacityPerDay?: number;
}

/** 概算エンジンの出力。cost/period は対応する入力があるときだけ付く。 */
export interface EstimateResult {
  effort: Range;
  cost?: Range;
  period?: Range;
  confidence: Confidence;
}

/** 要件変更（付け足し／削減）。工数の三点で表す。 */
export interface ScopeChange {
  kind: "add" | "remove";
  /** 変更ぶんの工数（三点、person-day） */
  effort: ThreePoint;
}

/** 要件変更の再計算結果（前後とその差）。 */
export interface RecalcResult {
  before: EstimateResult;
  after: EstimateResult;
  /** 期待工数の差（after - before）。付け足しは正、削減は負。 */
  deltaEffort: number;
}

const EPS = 1e-9;

function assertValidThreePoint(t: ThreePoint, label = "effort"): void {
  for (const [k, v] of Object.entries(t)) {
    if (!Number.isFinite(v)) {
      throw new RangeError(`${label}.${k} は有限の数値である必要があります: ${v}`);
    }
    if (v < 0) {
      throw new RangeError(`${label}.${k} は 0 以上である必要があります: ${v}`);
    }
  }
  if (t.optimistic > t.mostLikely + EPS || t.mostLikely > t.pessimistic + EPS) {
    throw new RangeError(
      `${label} は optimistic ≤ mostLikely ≤ pessimistic を満たす必要があります: ` +
        `(${t.optimistic}, ${t.mostLikely}, ${t.pessimistic})`,
    );
  }
}

/** PERT 期待値 (O + 4M + P) / 6。 */
export function pertExpected(t: ThreePoint): number {
  assertValidThreePoint(t);
  return (t.optimistic + 4 * t.mostLikely + t.pessimistic) / 6;
}

/** PERT 標準偏差 (P - O) / 6。幅（不確実性）の目安。 */
export function pertStdDev(t: ThreePoint): number {
  assertValidThreePoint(t);
  return (t.pessimistic - t.optimistic) / 6;
}

/**
 * 単一点の見積りしか無いとき、Cone of Uncertainty で幅を与える。
 * 「点で確定するな」を機械的に強制するヘルパ（DP-6）。
 */
export function coneRange(
  point: number,
  phase: ConePhase,
): { low: number; high: number } {
  if (!Number.isFinite(point) || point < 0) {
    throw new RangeError(`point は 0 以上の有限数である必要があります: ${point}`);
  }
  const f = CONE_FACTORS[phase];
  return { low: point * f.low, high: point * f.high };
}

/** 変動係数（stdDev / expected）から信頼度ラベルを導く。 */
export function confidenceOf(range: Range): Confidence {
  if (range.expected <= EPS) return "high"; // ゼロ工数は幅もゼロ＝確実
  const cv = range.stdDev / range.expected;
  if (cv < 0.1) return "high";
  if (cv < 0.25) return "medium";
  return "low";
}

function rangeFromThreePoint(t: ThreePoint): Range {
  return {
    expected: pertExpected(t),
    low: t.optimistic,
    high: t.pessimistic,
    stdDev: pertStdDev(t),
  };
}

function scaleRange(r: Range, factor: number): Range {
  return {
    expected: r.expected * factor,
    low: r.low * factor,
    high: r.high * factor,
    stdDev: r.stdDev * factor,
  };
}

/**
 * 工数の三点見積りから、工数・コスト・期間をレンジで返す。
 * dayRate があればコスト、capacityPerDay があれば期間を付ける。
 */
export function estimate(input: EstimateInput): EstimateResult {
  assertValidThreePoint(input.effort);
  const effort = rangeFromThreePoint(input.effort);
  const result: EstimateResult = {
    effort,
    confidence: confidenceOf(effort),
  };
  if (input.dayRate !== undefined) {
    if (!Number.isFinite(input.dayRate) || input.dayRate < 0) {
      throw new RangeError(`dayRate は 0 以上の有限数である必要があります: ${input.dayRate}`);
    }
    result.cost = scaleRange(effort, input.dayRate);
  }
  if (input.capacityPerDay !== undefined) {
    if (!Number.isFinite(input.capacityPerDay) || input.capacityPerDay <= 0) {
      throw new RangeError(
        `capacityPerDay は正の有限数である必要があります: ${input.capacityPerDay}`,
      );
    }
    result.period = scaleRange(effort, 1 / input.capacityPerDay);
  }
  return result;
}

/** 三点どうしを合成（付け足し＝加算、削減＝減算しつつ 0 で下限クランプ）。 */
export function combineThreePoint(
  base: ThreePoint,
  change: ScopeChange,
): ThreePoint {
  assertValidThreePoint(base, "base");
  assertValidThreePoint(change.effort, "change.effort");
  const sign = change.kind === "add" ? 1 : -1;
  const clamp = (v: number) => Math.max(0, v);
  return {
    optimistic: clamp(base.optimistic + sign * change.effort.optimistic),
    mostLikely: clamp(base.mostLikely + sign * change.effort.mostLikely),
    pessimistic: clamp(base.pessimistic + sign * change.effort.pessimistic),
  };
}

/**
 * 要件変更 → 工数の即時再計算（D の中核ロジック）。
 * ベース入力と変更から、変更前後の見積りと期待工数の差を返す。
 */
export function recalcWithChange(
  input: EstimateInput,
  change: ScopeChange,
): RecalcResult {
  const before = estimate(input);
  const after = estimate({
    ...input,
    effort: combineThreePoint(input.effort, change),
  });
  return {
    before,
    after,
    deltaEffort: after.effort.expected - before.effort.expected,
  };
}
