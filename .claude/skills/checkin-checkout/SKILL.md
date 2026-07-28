---
name: checkin-checkout
description: セッションの引継ぎ（handoff）を読み書きする簡易チェックイン/チェックアウト。ロードマップ（docs/roadmap.html）を読む・書くセッションで発動する。handoff は docs/roadmap.html の meta.handoff に一体化（①今回実施 ②今回トラブル ③次回=meta.next）。チェックイン=meta.handoff と meta.active/next を読み、それを踏まえて「今回やること」をユーザーに提示する。チェックアウト=ロードマップJSONを更新する瞬間に meta.handoff を上書きし、失敗は docs/failures.md に追記して commit & push し、CIが緑になったところまで確認してPRのマージまで完了させる。
---

# チェックイン / チェックアウト（簡易引継ぎ）

セッションをまたぐ**揮発的な文脈**を、ロードマップ本編に**同梱**して持ち回る仕組み。
handoff は独立ファイルではなく **`docs/roadmap.html` の `meta.handoff`** に置く。

## 大原則

- **handoff は roadmap に一体化**：`meta.handoff = { done, trouble }` ＋ `meta.next`（③）。
  独立した `docs/handoff.md` は使わない（廃止済み）。
  - **なぜ**：handoff を本編（毎PRで必ず main に乗る `docs/roadmap.html`）と同じファイルにすることで、
    「別枝に書いて未マージで消える」事故を**構造的に**防ぐ。CI 関所 `roadmap-required` が全PRに roadmap 差分を必須化する。
- **handoff は上書き（最新1件）／失敗は蓄積**：ミス・失敗の記録は上書きだと消えて意味がないので、
  `docs/failures.md` に **append（消さない）** で積む。handoff の②はあくまで「今回セッションの揮発メモ」。
- **二重管理禁止**：進捗・状態・criteria/verify/evidence は roadmap ノードの正であり、`meta.handoff` には書かない。

## handoff の構造（固定3項目）

- **①今回実施（`meta.handoff.done`）**：このセッションで何をやったか。
- **②今回トラブル（`meta.handoff.trouble`）**：ハマり所・環境の癖・暫定判断。特筆無しなら「無し」。
- **③次回やる事（`meta.next`）**：次の一手。特筆無しなら「ロードマップの続き」。

## ① チェックイン（セッション開始時 = 読む）

`meta.active` / `meta.next` を報告する儀式と同じタイミングで実行する。

1. `docs/roadmap.html` の `meta.active` / `meta.next` / `meta.handoff` を読む。
2. **`meta.template:true`（白紙テンプレ）の場合**＝このリポジトリのコピー直後。`meta.handoff.nav`
   （初回接続トップ手順ナビ）を読み、「白紙テンプレなので、まず案件のゴールをヒアリングして原子ツリーを
   描きます」と丁寧語で伝え、nav の手順を「今回やること」として提示する（下記チェックアウトはツリーを
   描き `meta.template` を false にする瞬間に行う）。この場合、以降の3は飛ばしてよい。
3. **通常（`meta.template` が無い/false）の場合**：`meta.handoff.done` / `.trouble` を1〜2行で要約して
   ユーザーに提示する（空なら「引継ぎなし」）。その内容と `meta.next` を踏まえ、「今回のセッションで何を
   やるか」を提示する（`meta.next` を第一候補に、handoff が示す残課題があれば並べる）。

## ② チェックアウト（ロードマップJSONを更新する瞬間 = 書く）

作業ノードを閉じてロードマップ JSON を編集する、その同じ瞬間に handoff も更新する。

1. **前回の値を消してから**、今回の値を上書きする：
   - `meta.handoff.done` ＝ ①今回実施。
   - `meta.handoff.trouble` ＝ ②今回トラブル（無ければ「無し」）。
   - `meta.next` ＝ ③次回やる事（無ければ「ロードマップの続き」）。
   - **白紙テンプレを卒業する初回だけ**：原子ツリーを描き直したこのタイミングで、`meta.template` を
     false（または削除）にし、`meta.handoff.nav` を削除する。以降 CI が本物の原子ツリーを機械強制する。
2. **失敗があれば `docs/failures.md` に1件 append**（日付＋事象＋根因＋教訓）。ここは消さない。
3. `docs/roadmap.html`（＋あれば `docs/failures.md`）を保存し、**commit & push** する。
   - 全PRは `roadmap-required` により roadmap 差分が必須。②③は毎回書けるので diff 0 はあり得ない（例外なし）。
4. **PRを出す／既存PRへの反映を確認する**。このブランチに対応するPRが無ければ新規作成する（テンプレがあれば従う）。
   既にPRがある場合は、今回のpushがそのPRに乗ったことを確認する。
5. **CIの完走を確認し、緑ならマージまで実行する**。AGENTS.md の運用（「変更はPRを出せば誰でもレビュー/承認して
   マージしてよい。守るのはCIが緑なことだけ」）に従い、チェックアウトは**マージ完了まで**を完了条件とする。
   - 必須チェック（`ci-green` / `roadmap-required` 等）が全て緑になるまで確認する。CIが赤・実行中のままでは
     マージしない。マージ操作は GitHub のマージ機能（native auto-merge の有効化、または直接マージ）で行う。
   - **例外＝マージしない／保留する場合**は、その理由をチェックアウト報告に明記する（例：CIが赤、必須チェックが
     未完走、マージ済みブランチへの追いpushでレビュー対応が積み残っている等）。理由なく「未マージのまま」で
     チェックアウトを終えない。
   - **既知の注意点**（`docs/failures.md` 2026-07-25参照）：CodeRabbitのレビューはCIより遅れて届くことがあり、
     CI緑での即マージ後にレビュー指摘が届く場合がある。指摘が来たら、マージ済みブランチへの追いpushは避け、
     `main` から枝を作り直して新PRとして出し直す。
6. マージ後、次回チェックインが最新 `main` から始まるよう、後続作業が必要な場合は改めて `main` から
   ブランチを作り直す（マージ済みブランチへの追いpushはしない）。
