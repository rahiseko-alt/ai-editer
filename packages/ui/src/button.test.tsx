import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Button } from "./button";

// 本物のテスト（echo の置き換え）。Button の実挙動 = 基底クラス保持・className 合成・
// props 伝播 を静的マークアップで検証する。0 件やダミーでは緑にならない。
describe("Button", () => {
  it("renders a <button> carrying the base classes and children", () => {
    const html = renderToStaticMarkup(<Button>Shared UI Button</Button>);
    expect(html).toContain("<button");
    expect(html).toContain("bg-black");
    expect(html).toContain("Shared UI Button");
  });

  it("appends a custom className while keeping the base classes", () => {
    const html = renderToStaticMarkup(<Button className="extra-class" />);
    expect(html).toContain("extra-class");
    expect(html).toContain("bg-black");
  });

  it("forwards native button attributes such as type", () => {
    const html = renderToStaticMarkup(<Button type="submit" />);
    expect(html).toContain('type="submit"');
  });
});
