"use client";

// D2: リモートのコマ中に、講師と受講者が画面共有で操作し、結果を即時に見られる概算UI。
// 状態→表示の計算は lib/estimateForm.ts（DOM非依存で単体テスト済み）に委ね、
// ここでは入力の受け皿とレンダリングだけを担う。

import { useMemo, useState } from "react";

import {
  INITIAL_FORM_STATE,
  deriveEstimateView,
  draftToThreePoint,
  parseOptionalNumberDraft,
  threePointToDraft,
  type EstimateFormState,
  type ThreePointDraft,
} from "../../lib/estimateForm";
import type { Range } from "../../lib/estimate";

type ScopeKind = "none" | "add" | "remove";

function formatRange(range: Range, unit: string): string {
  return `${range.low.toFixed(1)} 〜 ${range.high.toFixed(1)} ${unit}（期待値 ${range.expected.toFixed(1)}）`;
}

const CONFIDENCE_LABEL: Record<string, string> = {
  high: "高い",
  medium: "中くらい",
  low: "低い（幅が大きい）",
};

function ThreePointInputs({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ThreePointDraft;
  onChange: (next: ThreePointDraft) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2 rounded-md border border-gray-300 p-3">
      <legend className="px-1 text-sm font-medium">{label}</legend>
      <div className="flex gap-3">
        <label className="flex flex-col text-xs text-gray-600">
          楽観
          <input
            type="text"
            inputMode="decimal"
            className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
            value={value.optimistic}
            onChange={(e) => onChange({ ...value, optimistic: e.target.value })}
          />
        </label>
        <label className="flex flex-col text-xs text-gray-600">
          最頻
          <input
            type="text"
            inputMode="decimal"
            className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
            value={value.mostLikely}
            onChange={(e) => onChange({ ...value, mostLikely: e.target.value })}
          />
        </label>
        <label className="flex flex-col text-xs text-gray-600">
          悲観
          <input
            type="text"
            inputMode="decimal"
            className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
            value={value.pessimistic}
            onChange={(e) => onChange({ ...value, pessimistic: e.target.value })}
          />
        </label>
      </div>
    </fieldset>
  );
}

export default function EstimatePage() {
  const [effortDraft, setEffortDraft] = useState<ThreePointDraft>(
    threePointToDraft(INITIAL_FORM_STATE.effort),
  );
  const [dayRateDraft, setDayRateDraft] = useState("");
  const [capacityDraft, setCapacityDraft] = useState("");
  const [scopeKind, setScopeKind] = useState<ScopeKind>("none");
  const [scopeEffortDraft, setScopeEffortDraft] = useState<ThreePointDraft>({
    optimistic: "0",
    mostLikely: "0",
    pessimistic: "0",
  });

  const effectiveForm = useMemo<EstimateFormState>(
    () => ({
      effort: draftToThreePoint(effortDraft),
      dayRate: parseOptionalNumberDraft(dayRateDraft),
      capacityPerDay: parseOptionalNumberDraft(capacityDraft),
      scopeChange:
        scopeKind === "none" ? null : { kind: scopeKind, effort: draftToThreePoint(scopeEffortDraft) },
    }),
    [effortDraft, dayRateDraft, capacityDraft, scopeKind, scopeEffortDraft],
  );

  const view = useMemo(() => deriveEstimateView(effectiveForm), [effectiveForm]);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <div>
        <h1 className="text-2xl font-bold">工数・コスト概算アプリ</h1>
        <p className="text-sm text-gray-600">
          入力を変えると、下の結果がその場で再計算されます。画面共有しながら操作してください。
        </p>
      </div>

      <ThreePointInputs label="工数（person-day）" value={effortDraft} onChange={setEffortDraft} />

      <fieldset className="flex flex-col gap-2 rounded-md border border-gray-300 p-3">
        <legend className="px-1 text-sm font-medium">単価・稼働（任意）</legend>
        <div className="flex gap-3">
          <label className="flex flex-col text-xs text-gray-600">
            単価（1人日あたり）
            <input
              type="text"
              inputMode="decimal"
              className="w-32 rounded border border-gray-300 px-2 py-1 text-sm"
              value={dayRateDraft}
              placeholder="未入力"
              onChange={(e) => setDayRateDraft(e.target.value)}
            />
          </label>
          <label className="flex flex-col text-xs text-gray-600">
            稼働能力（人日/暦日）
            <input
              type="text"
              inputMode="decimal"
              className="w-32 rounded border border-gray-300 px-2 py-1 text-sm"
              value={capacityDraft}
              placeholder="未入力"
              onChange={(e) => setCapacityDraft(e.target.value)}
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2 rounded-md border border-gray-300 p-3">
        <legend className="px-1 text-sm font-medium">要件変更（任意）</legend>
        <label className="flex flex-col text-xs text-gray-600">
          種別
          <select
            className="w-40 rounded border border-gray-300 px-2 py-1 text-sm"
            value={scopeKind}
            onChange={(e) => setScopeKind(e.target.value as ScopeKind)}
          >
            <option value="none">変更なし</option>
            <option value="add">追加</option>
            <option value="remove">削減</option>
          </select>
        </label>
        {scopeKind !== "none" && (
          <ThreePointInputs
            label="変更分の工数（person-day）"
            value={scopeEffortDraft}
            onChange={setScopeEffortDraft}
          />
        )}
      </fieldset>

      <section
        className="rounded-md border border-gray-300 bg-gray-50 p-4"
        aria-live="polite"
        data-testid="estimate-result"
      >
        {view.error && <p className="text-sm text-red-600">{view.error}</p>}

        {view.result && (
          <div className="flex flex-col gap-1 text-sm">
            <p>工数：{formatRange(view.result.effort, "人日")}</p>
            {view.result.cost && <p>コスト：{formatRange(view.result.cost, "円")}</p>}
            {view.result.period && <p>期間：{formatRange(view.result.period, "暦日")}</p>}
            <p>信頼度：{CONFIDENCE_LABEL[view.result.confidence]}</p>
          </div>
        )}

        {view.recalc && (
          <div className="flex flex-col gap-1 text-sm">
            <p>変更前 工数：{formatRange(view.recalc.before.effort, "人日")}</p>
            <p>変更後 工数：{formatRange(view.recalc.after.effort, "人日")}</p>
            <p className="font-medium">
              差分：{view.recalc.deltaEffort >= 0 ? "+" : ""}
              {view.recalc.deltaEffort.toFixed(1)} 人日
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
