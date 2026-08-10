// この開発環境には Playwright の Chromium が /opt/pw-browsers に事前導入されている場合がある
// （バージョンが npm の playwright パッケージと食い違うと、既定の launch() は「ダウンロードし直せ」
// と言って失敗する）。存在すればそれを使い、無ければ既定の解決（CI が playwright install で
// 入れたもの）に任せる。
import fs from "node:fs";

const PRELOADED_CHROMIUM = "/opt/pw-browsers/chromium";

/** chromium.launch() へ渡す options を返す。事前導入があれば executablePath を足す。 */
export function chromiumLaunchOptions(extra = {}) {
  const opts = { headless: true, ...extra };
  if (fs.existsSync(PRELOADED_CHROMIUM)) {
    opts.executablePath = PRELOADED_CHROMIUM;
  }
  return opts;
}
