// 鍵の保管ガードについて、文書の主張と実装が一致していることの検証 — P1-14-D
//
// docs/key-management-policy.md:22は「親.gitignore + .claude/settings.json deny +
// secret-write-gate.mjsの三重ガード」と主張していたが、secret-write-gate.mjsはリポジトリに
// 存在せず、.claude/settings.jsonにもpermissions.denyブロックが無かった。実在するのは
// .gitignoreの1枚のみだった(M-6、docs/audits/2026-08-13-security-audit.md)。
//
// このテストは「文書がまだ実在しない保護を"有効"と言い切っていないか」を機械で確認する。
// 実装が先に進んでも(secret-write-gate.mjsが将来実装されても)、この検査自体は壊れない
// (存在するかどうかを見るだけで、無いことを固定的に要求してはいない)。壊れてはいけないのは
// 「文書が"三重ガード"のように、実在しないものを有効だと言い切る」ことの再発防止。
//
// 実行: node tests/security-key-policy-doc-check.mjs   (全PASSで exit 0)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(ROOT);
const DOC_PATH = path.join(REPO_ROOT, "docs", "key-management-policy.md");

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ": " + detail : ""}`); }
}

const doc = fs.readFileSync(DOC_PATH, "utf-8");

// ── 実在するべき唯一の実ガード: ルート.gitignoreの.env除外 ────────
{
  const gitignore = fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf-8");
  const excludesEnv = gitignore.split(/\r?\n/).some((ln) => ln.trim() === ".env" || ln.trim() === ".env.*");
  report(
    "前提: ルート.gitignoreが実際に.env/.env.*をgit追跡から除外している",
    excludesEnv,
    "該当行が見つからない",
  );
}

// ── 「三重ガード」という、実態と食い違っていた表現が文書から除去されている ──
report(
  "P1-14-D: docs/key-management-policy.mdに「三重ガード」という表現が残っていない",
  !doc.includes("三重ガード"),
);

// ── secret-write-gate.mjs / .claude/settings.json deny の扱いが誠実であること ──
// 文書がこれらに言及する場合、「実在する・有効である」と言い切っていないか(未実装/残課題として
// 明記されているか)を、実在チェックと突き合わせて確認する。
{
  const secretGateExists = fs.existsSync(path.join(REPO_ROOT, "secret-write-gate.mjs"))
    || fs.existsSync(path.join(REPO_ROOT, "scripts", "secret-write-gate.mjs"))
    || fs.existsSync(path.join(REPO_ROOT, ".claude", "hooks", "secret-write-gate.mjs"));

  if (doc.includes("secret-write-gate.mjs")) {
    if (secretGateExists) {
      report("対照: secret-write-gate.mjsが実装されている(文書がこれを有効と書いても矛盾しない)", true);
    } else {
      // 実在しないのに言及するなら、未実装/残課題として明記されていることを要求する。
      const mentionsAsBacklog = /(残課題|未実装|backlog)/.test(doc);
      report(
        "P1-14-D: secret-write-gate.mjsは未実装のため、文書は「有効なガード」ではなく未実装/残課題として言及している",
        mentionsAsBacklog,
        "「残課題」「未実装」等の語を伴わずにsecret-write-gate.mjsへ言及している(実在しないものを有効と誤読させる恐れ)",
      );
    }
  }

  const settingsPath = path.join(REPO_ROOT, ".claude", "settings.json");
  const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf-8")) : {};
  const hasEnvDeny = Array.isArray(settings?.permissions?.deny)
    && settings.permissions.deny.some((rule) => typeof rule === "string" && rule.includes(".env"));

  if (doc.includes(".claude/settings.json")) {
    if (hasEnvDeny) {
      report("対照: .claude/settings.jsonに.env向けdeny設定が実在する(文書がこれを有効と書いても矛盾しない)", true);
    } else {
      const mentionsAsBacklog = /(残課題|未実装|backlog)/.test(doc);
      report(
        "P1-14-D: .claude/settings.jsonの.env deny設定は未実装のため、文書は未実装/残課題として言及している",
        mentionsAsBacklog,
        "「残課題」「未実装」等の語を伴わずに.claude/settings.json denyへ言及している(実在しないものを有効と誤読させる恐れ)",
      );
    }
  }
}

console.log(`\n--- ${pass} PASS / ${fail} FAIL ---`);
process.exit(fail === 0 ? 0 : 1);
