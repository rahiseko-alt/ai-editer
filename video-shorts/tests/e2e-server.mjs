// server 経由 end-to-end 通電クライアント（手動検証用）。
// 使い方: node tests/e2e-server.mjs [動画パス] [sub:on|none]
// POST /api/jobs に動画を raw 送信 → SSE 進捗を表示 → candidates 到達で終了。
import fs from "node:fs";
import http from "node:http";

const HOST = "127.0.0.1", PORT = 5178;
const file = process.argv[2] || "samples/talk-16x9.mp4";
const sub = process.argv[3] || "none";
const name = file.split(/[\\/]/).pop();
const buf = fs.readFileSync(file);
const q = new URLSearchParams({ sub, cut: "topic", size: "9:16", name }).toString();

function post() {
  return new Promise((res, rej) => {
    const req = http.request(
      { host: HOST, port: PORT, path: "/api/jobs?" + q, method: "POST",
        headers: { "Content-Type": "application/octet-stream", "Content-Length": buf.length } },
      (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res({ status: r.statusCode, body: d })); }
    );
    req.on("error", rej); req.write(buf); req.end();
  });
}

const r = await post();
console.log("POST /api/jobs ->", r.status, r.body);
if (r.status < 200 || r.status >= 300) process.exit(1);
const { jobId } = JSON.parse(r.body);
console.log("jobId =", jobId, "/ source =", file, "(" + (buf.length / 1048576).toFixed(1) + "MB) sub=" + sub);

// 完了判定は「SSE の done イベント受信後に candidates 取得」で行う（古い candidates 誤検出を防ぐ）
function fetchCandidates() {
  return new Promise((resolve) => {
    http.get({ host: HOST, port: PORT, path: `/api/jobs/${jobId}/candidates` }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    }).on("error", () => resolve({ status: 0, body: "" }));
  });
}

let sseBuf = "", finished = false;
http.get({ host: HOST, port: PORT, path: `/api/jobs/${jobId}/events` }, (res) => {
  res.setEncoding("utf8");
  res.on("data", async (c) => {
    process.stdout.write(c.split("\n").filter(Boolean).map((l) => "[SSE] " + l).join("\n") + "\n");
    sseBuf += c;
    if (!finished && /event:\s*done/.test(sseBuf)) {
      finished = true;
      const r = await fetchCandidates();
      if (r.status === 200) {
        const j = JSON.parse(r.body);
        console.log(`\n[DONE] generated=${j.generated}`);
        j.candidates.forEach((c) => console.log(`  #${c.index} ${c.start.toFixed(1)}-${c.end.toFixed(1)}s "${c.hook}" -> ${c.file} (${c.width}x${c.height})`));
        process.exit(0);
      }
      console.log(`\n[DONE but candidates ${r.status}]`);
      process.exit(1);
    }
    if (!finished && /event:\s*error/.test(sseBuf)) {
      finished = true;
      console.log("\n[ERROR event received]");
      process.exit(1);
    }
  });
}).on("error", (e) => console.log("[SSE error]", e.message));

setTimeout(() => { console.log("[TIMEOUT]"); process.exit(1); }, 1500000);
