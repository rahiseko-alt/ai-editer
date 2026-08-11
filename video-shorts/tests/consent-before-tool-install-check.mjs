// tests/consent-before-tool-install-check.mjs — P1-12-B の機械検証。
//
// 【何の穴を塞ぐか】roadmap P1-12-B「初回実行時に同意を得る」。start-here.md には
// 2つの経路がある:
//   (1) ローカルPC経路: ⓪ではじめの説明と同意を取り、① で Node/Python/ffmpeg を
//       「何がなぜ必要かを説明→入手方法提示→承認を得てから導入」する✋ゲートがある。
//   (2) クラウドリモート経路: `.claude/hooks/session-start.sh` がセッション開始時に
//       無音でffmpeg/文字起こしライブラリを自動導入してしまう(フック実行前にユーザーと
//       対話できないため事前同意が技術的に不可能)。このため start-here.md 冒頭に、
//       「承認前に自動導入済み・入れたのはこの2つだけ」と開示してから同意確認するよう
//       明記されている(事後開示+同意)。
//
// このテストは start-here.md の実物テキストを読み、上記(1)(2)双方の同意フローの
// 文言が実際に存在することを確認する。「文言が無いこと」を検知できる正規表現かどうかは、
// 意図的に文言を欠落させた変異テキストに対して先に走らせる対照実験で裏付ける
// (AGENTS.md 検証の規律: 「無いこと」の検出手段は「有るとき有ると言える」対照が要る)。
//
// 実行: node tests/consent-before-tool-install-check.mjs   (全PASSで exit 0)

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIDEO_SHORTS_ROOT = path.dirname(HERE);
const START_HERE_PATH = path.join(VIDEO_SHORTS_ROOT, "start-here.md");

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

assert.ok(fs.existsSync(START_HERE_PATH), `start-here.mdが見つかりません: ${START_HERE_PATH}`);
const text = fs.readFileSync(START_HERE_PATH, "utf8");

// ---- 検知に使う正規表現を定義し、まず「文言が無い変異テキスト」で対照実験する ----

// (1) クラウド経路: 承認前の自動導入を開示する一文
const cloudDisclosureRe = /承認する前にこのクラウド環境へ自動で入れてあります/;
{
  const mutated = text.replace(cloudDisclosureRe, "（開示文なし）");
  report(
    "P1-12-B: 対照 - クラウド経路の開示文を除去した変異テキストでは検知されない",
    !cloudDisclosureRe.test(mutated),
  );
  report(
    "P1-12-B: 対照 - 現在のstart-here.mdでは開示文が検知される(除去前は検知される)",
    cloudDisclosureRe.test(text),
  );
}

// (2) クラウド経路: 開示のあとにユーザーの同意確認を挟む一文(「①へ進む」の直前に確認する、の意)
const cloudConsentRe = /ユーザーがそれで良いか確認したうえで/;
{
  const mutated = text.replace(cloudConsentRe, "（同意確認なし）");
  report(
    "P1-12-B: 対照 - クラウド経路の同意確認文を除去した変異テキストでは検知されない",
    !cloudConsentRe.test(mutated),
  );
  report("P1-12-B: クラウド経路は開示のあとユーザーの同意確認を挟んでいる", cloudConsentRe.test(text));
}

// (3) ローカル経路: ⓪ はじめの説明と同意ゲートの見出しが存在する
const localGate0Re = /## ⓪ ✋ はじめの説明と同意/;
{
  const mutated = text.replace(localGate0Re, "## ⓪ 説明");
  report(
    "P1-12-B: 対照 - ⓪✋ゲート見出しを除去した変異テキストでは検知されない",
    !localGate0Re.test(mutated),
  );
  report("P1-12-B: ローカル経路に⓪✋はじめの説明と同意ゲートがある", localGate0Re.test(text));
}

// (4) ローカル経路: ① で Node/Python/ffmpeg 導入前に「何がなぜ必要か説明→入手方法提示→承認」の順が明記
const localInstallConsentRe = /何がなぜ必要かを説明\s*→\s*入手方法を提示\s*→\s*承認を得てから導入/;
{
  const mutated = text.replace(localInstallConsentRe, "（導入前の説明・承認の記述なし）");
  report(
    "P1-12-B: 対照 - ①の説明→提示→承認の記述を除去した変異テキストでは検知されない",
    !localInstallConsentRe.test(mutated),
  );
  report(
    "P1-12-B: ローカル経路は①でNode/Python/ffmpeg導入前に説明→提示→承認の順を明記している",
    localInstallConsentRe.test(text),
  );
}

// (5) ⓪の同意ゲートが、①(ソフト導入)より前の行に出現する(順序が入れ替わっていない)
{
  const gate0Index = text.search(localGate0Re);
  const gate1Index = text.search(/## ① ✋ 必要なソフトの導入/);
  report(
    "P1-12-B: ⓪(説明と同意)が①(ソフト導入)より前に配置されている",
    gate0Index >= 0 && gate1Index >= 0 && gate0Index < gate1Index,
    `gate0Index=${gate0Index}, gate1Index=${gate1Index}`,
  );
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
if (fail > 0) process.exit(1);
