import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import Home from "../app/page";

// 本物のテスト（echo の置き換え）。トップページが主要コンテンツを描画し、
// packages/ui の共有 Button を実際に組み込んでいることを静的マークアップで検証する。
describe("Home page", () => {
  it("renders the heading and description", () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain("cc-v2 monorepo");
    expect(html).toContain("apps/web + packages/ui");
  });

  it("mounts the shared UI Button", () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain("<button");
    expect(html).toContain("Shared UI Button");
    expect(html).toContain("bg-black");
  });
});
