import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import EstimatePage from "../app/estimate/page";

// D2 のUI初期表示を静的マークアップで検証する（packages/ui の button.test.tsx と同じ方式）。
// インタラクション（入力変更→再計算）は estimateForm.test.ts で DOM非依存に検証済み。
describe("EstimatePage", () => {
  it("見出しと初期状態の結果（工数レンジ・信頼度）を表示する", () => {
    const html = renderToStaticMarkup(<EstimatePage />);
    expect(html).toContain("工数・コスト概算アプリ");
    expect(html).toContain("工数");
    expect(html).toContain("5.0"); // 初期値 {2,4,12} の PERT 期待値
    expect(html).toContain("信頼度");
  });

  it("トップページから概算アプリへのリンクがある", async () => {
    const { default: Home } = await import("../app/page");
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain('href="/estimate"');
  });
});
