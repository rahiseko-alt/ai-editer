# 手法確立：ローカルWebアプリ＋チャット欄で"裏のClaude"を動かす

> 調査 2026-06-20（GitHub実例＋Claude Code公式仕様）。AI-Editer video-shorts を
> 「客PC上のローカルWeb編集アプリ＋チャット欄」に進化させるための確立手法。
> 目的=ブラウザUI→ローカルNode橋→Claude Code→応答をストリーム表示、クラウド不要・コスト≒0。

## 結論（採用する手法）

| 要素 | 採用 | 理由 |
|---|---|---|
| Claude 接続 | **`claude -p`（CLI）を subprocess で spawn** | 既存サブスクのログインを継承＝**追加課金なし**。Agent SDK は既定で API キー（従量課金）なので不採用 |
| ストリーム形式 | `--output-format stream-json --include-partial-messages`（NDJSON） | 行ごとに parse してトークン逐次表示 |
| UI⇄サーバ | **SSE（Server-Sent Events）** | 単方向ストリームに最小実装。ブラウザは `EventSource` ネイティブのみ |
| サーバ | 小さな Node（Express/Hono） | 今の `python -m http.server` を置換。UI配信＋`/chat`＋将来`/render``/transcribe` |
| 会話継続 | `--resume <session_id>` | 初回 json から session_id を取り、次ターンで再開 |
| 認証 | 事前に `claude` ログイン済み前提 | API キー不要＝コスト0の核心 |

```
ブラウザ（チャット欄＋動画UI）
   ↓ SSE (/chat)
ローカルNodeサーバ（橋）
   ↓ child_process: claude -p --output-format stream-json
Claude Code（既存サブスクで動く＝コスト0）
```

## コスト解決（調査での最重要点）

- **CLI（`claude -p`）= サブスクログイン継承 → 追加課金なし**（claude-code-guide【確信度:高】／実在OSS claudecodeui・claude-code-webui が同方式）
- **Agent SDK（`@anthropic-ai/claude-agent-sdk`）= 既定 `ANTHROPIC_API_KEY` 必須 → トークン従量課金**
- → AI-Editer のコスト0要件には **CLI subprocess 方式を採用**。SDK は構造の参考のみ。

## 参考にする実在リポジトリ（手本）

| repo | スター | 方式 | ライセンス | 採否 |
|---|---|---|---|---|
| [sugyan/claude-code-webui](https://github.com/sugyan/claude-code-webui) | ~1.1k | CLI subprocess＋SSE・ログイン継承・localhost | **MIT** | **第一手本**（小さく・商用可・要件一致） |
| [anthropics/claude-agent-sdk-demos](https://github.com/anthropics/claude-agent-sdk-demos)（simple-chat-app） | ~2.5k | Agent SDK＋Express＋WebSocket | **MIT** | 構造の参考（認証はAPIキーなので流用注意） |
| [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) | ~12k | フルGUI・ログイン継承 | **AGPL-3.0** | 参考のみ。**商用クローズド製品にfork不可**（コピーレフト） |
| [winfunc/opcode](https://github.com/winfunc/opcode) | ~22k | Tauriネイティブ | AGPL-3.0 | 参考のみ（同上ライセンス注意） |

> ⚠ **ライセンス警告（将来の販売に直結）**: claudecodeui / opcode は **AGPL-3.0**＝改変物の公開義務。売る製品の土台に使うと自前コードも公開強制リスク。**手本にするなら MIT の sugyan/claude-code-webui か公式demo**にする。

## 最小実装テンプレ（CLI＋SSE・コスト0版）

サーバ（橋）:
```js
// /chat: プロンプトを claude -p に渡し、トークンをSSEで流す
import { spawn } from "node:child_process";
app.post("/chat", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  const p = spawn("claude", ["-p", req.body.prompt,
    "--output-format", "stream-json", "--verbose", "--include-partial-messages"],
    { windowsHide: true });
  let buf = "";
  p.stdout.on("data", d => {
    buf += d.toString();
    const lines = buf.split("\n"); buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const j = JSON.parse(line);
      if (j.type === "stream_event" && j.event?.delta?.type === "text_delta")
        res.write(`data: ${JSON.stringify({ token: j.event.delta.text })}\n\n`);
      if (j.type === "result")
        res.write(`data: ${JSON.stringify({ done: true, session: j.session_id })}\n\n`);
    }
  });
  p.on("close", () => res.end());
});
```

ブラウザ（既存UIにチャット欄を足す）:
```js
const r = await fetch("/chat", { method:"POST",
  headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ prompt }) });
const reader = r.body.getReader(); const dec = new TextDecoder();
for (;;) { const { done, value } = await reader.read(); if (done) break;
  for (const line of dec.decode(value).split("\n"))
    if (line.startsWith("data: ")) { const d = JSON.parse(line.slice(6));
      if (d.token) chatEl.textContent += d.token; } }
```

## Windows / ローカル固有の落とし穴（要対策）

| 落とし穴 | 対策 |
|---|---|
| subprocess 初期化タイムアウト | spawn に timeout 300000ms 目安。Claude Code は最新版へ |
| `claude -p` 実行後にプロセスが残る | 新しめの版は数秒で自動終了。`close` で `res.end()` |
| 大きな stdin（10MB超） | プロンプトにファイルパスを渡す。stdin で巨大データを流さない |
| 権限制御 | `--allowedTools` / `--permission-mode` で headless の自動実行範囲を絞る |
| 「今この端末のClaude」ではない | 橋が起動するのは**別のClaudeインスタンス**。やれる事は同じだが文脈は別 |

## 検証コマンド（着手前の実機確認）

```bash
claude -v                                   # 版確認
claude -p "hello" --output-format stream-json --verbose   # NDJSON が出るか
```

## 次の一歩（推奨順）

1. 上の検証コマンドを実機で叩き、stream-json が出ることを確認（手法の実証）
2. 今の `python http.server` を小さな Node サーバに置換し `/chat`（SSE）を追加＝最小プロトタイプ
3. チャットから「字幕スタイル変更」「区間選定」など既存エンジン操作を `/render` 等で繋ぐ
4. P0ゲート（動画→ショートの実用性）と並行/後追いで段階導入

## 確信度・未確認

- CLI=サブスク継承でコスト0：**高**（公式＋実在OSS2件で一致）
- Agent SDK=APIキー従量：**高**
- claudecodeui/claude-code-webui の内部 transport 細部：一部**未確認**（README非記載・要ソース精査）
