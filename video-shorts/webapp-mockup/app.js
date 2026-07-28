// kosespark 無料版 UI — バックエンドAPI結線済み。
// POST /api/jobs → SSE /api/jobs/:id/events → GET /api/jobs/:id/candidates → DL /api/clips/:id/:file
// プレビュー正設計: デバイス枠は固定アスペクト（CSS で aspect-ratio 固定）。
// サイズ選択→.video-area の px のみを変更（contain 計算）。枠は一切変更しない。

const state = {
  file: null, sub: "none",
  cut: "topic", cutMin: 3,
  size: "9:16", device: "phone",
};
const $ = (id) => document.getElementById(id);

// P1-2(A): サーバーがindex.html配信時に埋め込む起動時トークン。
// fetch系はヘッダで、EventSource/ダウンロードリンクはカスタムヘッダを付けられないためクエリで送る。
// P1-4(B): ジョブごとに発行されるjobToken(POST /api/jobsの応答)も、そのジョブ関連の呼び出し
// (SSE/候補JSON/クリップDL)すべてに併せて付与する(起動時トークンだけでは他ジョブと区別できない)。
const API_TOKEN = window.__KOSESPARK_TOKEN__ || "";
function withTokenHeader(init = {}, jobToken = null) {
  const headers = { ...(init.headers || {}), "X-Kosespark-Token": API_TOKEN };
  if (jobToken) headers["X-Kosespark-Job-Token"] = jobToken;
  return { ...init, headers };
}
function withTokenQuery(url, jobToken = null) {
  const u = new URL(url, window.location.origin);
  u.searchParams.set("token", API_TOKEN);
  if (jobToken) u.searchParams.set("jobToken", jobToken);
  return u.pathname + u.search;
}

// ---- ファイル ----
const drop = $("drop"), fileInput = $("file");
["dragover", "dragenter"].forEach((e) =>
  drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add("drag"); }));
["dragleave", "drop"].forEach((e) => drop.addEventListener(e, () => drop.classList.remove("drag")));
drop.addEventListener("drop", (ev) => { ev.preventDefault(); const f = ev.dataTransfer.files?.[0]; if (f) setFile(f); });
fileInput.addEventListener("change", (ev) => { const f = ev.target.files?.[0]; if (f) setFile(f); });
$("clear-file").addEventListener("click", () => {
  state.file = null; $("filebar").classList.add("hidden"); drop.classList.remove("hidden"); refresh();
});
function setFile(f) {
  state.file = f; $("file-name").textContent = f.name;
  $("filebar").classList.remove("hidden"); drop.classList.add("hidden"); refresh();
}

// ---- チップ群（sub / cut / size）----
// .chips（sub / cut）と .size-chips（size）を両方カバー
document.querySelectorAll(".chips, .size-chips").forEach((group) => {
  const g = group.dataset.group;
  if (!g) return;
  group.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".chip"); if (!btn) return;
    group.querySelectorAll(".chip").forEach((b) => b.classList.remove("is-on"));
    btn.classList.add("is-on"); state[g] = btn.dataset.val;
    if (g === "sub") updateSubDesc();
    if (g === "cut") showCut();
    if (g === "size") updateVideoArea(btn);
    refresh();
  });
});

// ---- 端末切替タブ ----
document.querySelectorAll(".device-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".device-tab").forEach((t) => {
      t.classList.remove("is-on"); t.setAttribute("aria-pressed", "false");
    });
    tab.classList.add("is-on"); tab.setAttribute("aria-pressed", "true");
    state.device = tab.dataset.device;
    const phoneFrame = document.getElementById("phone-frame");
    const pcFrame = document.getElementById("pc-frame");
    if (state.device === "phone") {
      phoneFrame.classList.remove("hidden");
      pcFrame.classList.add("hidden");
    } else {
      phoneFrame.classList.add("hidden");
      pcFrame.classList.remove("hidden");
    }
    // 動画領域を切替後フレームに反映（デバイス枠は触らない）
    const active = document.querySelector(".size-chip.is-on");
    if (active) updateVideoArea(active);
  });
});

// ---- 動画表示領域 contain 計算（デバイス枠は触らない）----
// デバイス枠は CSS で aspect-ratio 固定済み。
// サイズ変更時は .device-screen 内の .video-area のみ変更する（contain レターボックス）。
function updateVideoArea(btn) {
  if (!btn) return;
  const ar = btn.dataset.ar || "9/16";
  const [arW, arH] = ar.split("/").map(Number);
  if (!arW || !arH) return;

  // スマホ・PC それぞれの screen 要素と video-area を更新
  const screenIds = [
    { screenId: "device-screen", areaId: "video-area-phone" },
    { screenId: "pc-screen",     areaId: "video-area-pc" },
  ];
  for (const { screenId, areaId } of screenIds) {
    const screen = document.getElementById(screenId);
    const area   = document.getElementById(areaId);
    if (!screen || !area) continue;
    // screen の実サイズで contain 計算（枠は一切変更しない）
    const sw = screen.clientWidth;
    const sh = screen.clientHeight;
    if (!sw || !sh) continue;
    const scale  = Math.min(sw / arW, sh / arH);
    const areaW  = Math.round(arW * scale);
    const areaH  = Math.round(arH * scale);
    area.style.width  = areaW + "px";
    area.style.height = areaH + "px";
    // data-ar を .video-area に保持（受け入れ基準#9 実測用）
    area.dataset.ar = ar;
  }
}

// 旧関数名エイリアス（呼び出し側の互換維持）
function updatePhoneAspect(btn) { updateVideoArea(btn); }
function updateDeviceAspect(btn) { updateVideoArea(btn); }

// リサイズ時は選択中サイズで動画領域を再計算
window.addEventListener("resize", () => {
  const active = document.querySelector(".size-chip.is-on");
  if (active) updateVideoArea(active);
});

// ---- 字幕説明文の更新 ----
function updateSubDesc() {
  const el = $("sub-desc");
  if (!el) return;
  el.textContent = state.sub === "on" ? "話した言葉を自動で字幕に焼き込みます。" : "字幕は付けません。";
}

// ---- カット詳細の表示切替＋入力 ----
function showCut() {
  document.querySelectorAll(".cut-note").forEach((p) => p.classList.toggle("hidden", p.dataset.for !== state.cut));
}
// サーバー(server/job-params.mjs)の正規化(1-60の有限値のみ許可・それ以外は既定3)と
// 表示・送信内容を一致させる（空/範囲外のまま「0分」等と表示してサーバー設定とずれるのを防ぐ）。
function normalizeCutMin(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 60 ? n : 3;
}
const cutMinInput = $("cut-min");
if (cutMinInput) cutMinInput.addEventListener("input", () => {
  state.cutMin = normalizeCutMin(cutMinInput.value); refresh();
});
function cutText() {
  if (state.cut === "topic") return "話題で切る（AIが切れ目を判断）";
  if (state.cut === "minutes") return `分数で切る（${state.cutMin}分以内・区切りの良い所）`;
  return "話題で切る（AIが切れ目を判断）";
}

// ---- AI確認文 ----
function refresh() {
  const ready = !!state.file;
  $("btn-run").disabled = !ready;
  // 押せない理由は動画未選択のときだけ出す
  $("cta-hint").classList.toggle("hidden", ready);
  const t = $("ai-text"), sm = $("summary");
  if (!ready) {
    t.textContent = "まずは動画を1つ入れてください。左上の枠にドラッグ、またはクリックで選べます。そのあと①〜④を上から選ぶだけです。";
    sm.classList.add("hidden"); sm.innerHTML = ""; return;
  }
  t.textContent = "準備OK！　あとは『編集実行』を押すだけです。内容はこちら：";
  sm.innerHTML = summaryHTML();
  sm.classList.remove("hidden");
}
// 編集内容サマリ（右の確認カードと中央モーダルで共用）
function summaryHTML() {
  const subText = state.sub === "on" ? "あり" : "なし";
  const rows = [["動画", state.file?.name || "—"], ["サイズ", state.size], ["字幕", subText], ["カット", cutText()]];
  return rows.map(([k, v]) => `<li><b>${k}</b><span>${esc(v)}</span></li>`).join("");
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---- タブ（採用候補 / 使わない候補）----
document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("is-on"));
  tab.classList.add("is-on");
  $("tab-keep").classList.toggle("hidden", tab.dataset.tab !== "keep");
  $("tab-trash").classList.toggle("hidden", tab.dataset.tab !== "trash");
}));

// ---- 編集実行: まず中央モーダルで最終確認 → 実行する/戻る ----
$("btn-run").addEventListener("click", openConfirm);
function openConfirm() {
  $("confirm-summary").innerHTML = summaryHTML();
  const ov = $("confirm-overlay");
  ov.classList.remove("hidden");
  requestAnimationFrame(() => ov.classList.add("show"));
}
function closeConfirm() {
  const ov = $("confirm-overlay");
  ov.classList.remove("show");
  setTimeout(() => ov.classList.add("hidden"), 300);
}
// 実行する=編集開始（進捗へ） / 戻る=操作画面に戻る
$("confirm-run").addEventListener("click", () => { closeConfirm(); run(); });
$("confirm-back").addEventListener("click", closeConfirm);
$("confirm-overlay").addEventListener("click", (e) => { if (e.target === $("confirm-overlay")) closeConfirm(); });

// duration 秒数 → "m:ss" 形式
function fmtDuration(sec) {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// 進捗 li を stage キー(t/s/r)で active / done に切替
function setStage(key, cls) {
  const li = document.querySelector(`#progress li[data-k="${key}"]`);
  if (!li) return;
  li.classList.remove("active", "done");
  if (cls) li.classList.add(cls);
}

// 編集中オーバーレイの段階ラベル（#progress li と同じ文言）
const EDITING_LABEL = {
  t: "話し言葉を文字にしています",
  s: "良い場面を選んでいます",
  r: "縦長の動画に整えています",
};
// 3段ステップ（t→s→r）の進捗を編集中窓に反映
const STEP_ORDER = ["t", "s", "r"];
function setEditingStep(stage, status) {
  const idx = STEP_ORDER.indexOf(stage);
  if (idx < 0) return;
  document.querySelectorAll("#editing-steps .estep").forEach((el, i) => {
    el.classList.remove("active", "done");
    if (i < idx) el.classList.add("done");
    else if (i === idx) el.classList.add(status === "done" ? "done" : "active");
  });
}
// 経過タイマー（実際に動いている＝止まっていない証拠）
let editTimer = null, editStart = 0;
function startEditTimer() {
  editStart = Date.now();
  $("editing-elapsed").textContent = "0:00";
  editTimer = setInterval(() => {
    const s = Math.floor((Date.now() - editStart) / 1000);
    $("editing-elapsed").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 1000);
}
function stopEditTimer() { if (editTimer) { clearInterval(editTimer); editTimer = null; } }

// 失敗時: 窓を閉じず、その場で「編集できませんでした＋理由」を明示
function showEditingError(msg) {
  stopEditTimer();
  $("editing-error-msg").textContent = `編集できませんでした：${msg}`;
  $("editing-error").classList.remove("hidden");
  $("editing-card").classList.add("is-error");
}

// 話し声なし等「そもそも編集できない」専用カード
function showCantEdit(reason) {
  hideEditing();
  $("btn-run").disabled = false;
  $("progress").classList.add("hidden");
  if (reason) $("cantedit-reason").textContent = reason;
  const c = $("cantedit-card");
  c.classList.remove("hidden");
  requestAnimationFrame(() => c.classList.add("show"));
}
function hideCantEdit() {
  const c = $("cantedit-card");
  c.classList.remove("show");
  setTimeout(() => c.classList.add("hidden"), 300);
}
$("cantedit-retry").addEventListener("click", () => {
  hideCantEdit();
  state.file = null; $("filebar").classList.add("hidden"); $("drop").classList.remove("hidden"); refresh();
  $("file").click();   // すぐ選び直せるようファイル選択を開く
});

function showEditing() {
  const c = $("editing-card");
  c.classList.remove("is-error");
  $("editing-error").classList.add("hidden");
  $("editing-status").textContent = "動画を読み込んでいます";
  document.querySelectorAll("#editing-steps .estep").forEach((el) => el.classList.remove("active", "done"));
  startEditTimer();
  c.classList.remove("hidden");
  requestAnimationFrame(() => c.classList.add("show"));
}
function hideEditing() {
  stopEditTimer();
  const c = $("editing-card");
  c.classList.remove("show");
  setTimeout(() => c.classList.add("hidden"), 300);
}

function run() {
  $("btn-run").disabled = true;
  $("btn-show-result").classList.add("hidden");     // 処理中は再表示導線を隠す
  showEditing();                                    // 編集中カード（ハサミ演出）を表示。進捗はカードに一本化
  // 進捗リセット
  document.querySelectorAll("#progress li").forEach((li) => li.classList.remove("active", "done"));

  const params = new URLSearchParams({
    sub: state.sub,
    cut: state.cut,
    size: state.size,
    name: state.file.name,
  });
  if (state.cut === "minutes") params.set("cutMin", String(state.cutMin));
  fetch(`/api/jobs?${params}`, withTokenHeader({ method: "POST", body: state.file }))
    .then((res) => {
      if (!res.ok) return res.json().then((d) => Promise.reject(d.error || d.message || "ジョブ作成失敗"));
      return res.json();
    })
    .then(({ jobId, jobToken }) => {
      const es = new EventSource(withTokenQuery(`/api/jobs/${jobId}/events`, jobToken));

      es.onmessage = (ev) => {
        let d;
        try { d = JSON.parse(ev.data); } catch { return; }
        const { stage, status, label } = d;
        if (status === "active") {
          setStage(stage, "active");
          setEditingStep(stage, "active");
          // サーバーが状況に応じたlabel(例: 縦長/横長、順番待ち)を送ってきた場合はそれを優先する。
          // 無ければ段階名からの既定文言(EDITING_LABEL)にフォールバックする。
          const text = label || EDITING_LABEL[stage];
          if (text) $("editing-status").textContent = text;
        }
        if (status === "done") {
          setStage(stage, "done");
          setEditingStep(stage, "done");
        }
      };

      es.addEventListener("done", () => {
        es.close();
        fetch(`/api/jobs/${jobId}/candidates`, withTokenHeader({}, jobToken))
          .then((r) => {
            if (!r.ok) return r.json().then((d) => Promise.reject(d.error || d.message || "候補取得失敗"));
            return r.json();
          })
          .then((data) => fillResults(jobId, jobToken, data.candidates || [], !!data.incomplete))
          .catch((msg) => showError(String(msg)));
      });

      es.addEventListener("error", (ev) => {
        es.close();
        let msg = "処理に失敗しました", code = null;
        try { const d = JSON.parse(ev.data); if (d.message) msg = d.message; code = d.code || null; } catch { /* ignore */ }
        if (code === "no_speech") return showCantEdit(msg);   // 専用カードへ
        showError(msg);
      });
    })
    .catch((msg) => showError(String(msg)));
}

function showError(msg) {
  $("ai-text").textContent = `処理に失敗しました：${msg}`;
  $("progress").classList.add("hidden");
  $("progress-note").classList.add("hidden");
  $("progress").querySelectorAll("li").forEach((li) => li.classList.remove("active", "done"));
  $("btn-run").disabled = false;
  showEditingError(String(msg));   // 窓を閉じずに失敗を明示（沈黙で消えない）
}
// 失敗窓の「閉じる」
$("editing-error-close").addEventListener("click", hideEditing);

// 作成履歴: 実行のたびに1ジョブを積む。閉じても消えない＝過去分も見返せる
let jobs = [];
let curJob = -1;
function activeJob() { return jobs[curJob] || null; }
function addJob(jobId, jobToken, candidates, incomplete) {
  const keep = (candidates || []).map((c) => ({
    h: c.hook || c.keepText || "（タイトル未取得）",
    d: fmtDuration(c.duration || 0),
    file: c.file,
  }));
  jobs.push({
    jobId,
    jobToken, // P1-4(B): このジョブの成果物取得に必要(クリップDL時に使う)
    label: state.file?.name || `動画${jobs.length + 1}`,
    keep,
    trash: [],   // エンジンは採用候補のみ返すため trash は空
    incomplete: !!incomplete, // P1-5: 区間選定の一部が失敗し、全編をカバーできていない場合true
  });
  curJob = jobs.length - 1;
}
// ジョブ選択チップ（2本目以降のときだけ表示）
function renderJobList() {
  const el = $("job-list");
  if (jobs.length <= 1) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  el.classList.remove("hidden");
  el.innerHTML =
    `<span class="job-list-label">作ったショート</span>` +
    jobs.map((j, i) =>
      `<button class="job-chip ${i === curJob ? "is-on" : ""}" data-j="${i}">${i + 1}. ${esc(j.label)}（${j.keep.length}本）</button>`).join("");
}
$("job-list").addEventListener("click", (e) => {
  const b = e.target.closest(".job-chip"); if (!b) return;
  curJob = +b.dataset.j;
  renderJobList(); renderResults();
});

function renderResults() {
  const job = activeJob(); if (!job) return;
  const KEEP = job.keep, TRASH = job.trash;
  $("keep-n").textContent = KEEP.length;
  $("trash-n").textContent = TRASH.length;
  $("tab-keep").innerHTML =
    // P1-5: 一部の区間選定に失敗している場合、成功扱いに見せず必ず明示する(黙って欠落させない)。
    (job.incomplete
      ? `<p class="reason warn">⚠ 動画の一部区間の解析に失敗したため、全編ではなく成功した範囲のみから選んでいます。</p>`
      : "") +
    `<p class="reason">あなたの設定をもとに、AIがそのまま使える部分を${KEEP.length}本選びました。短い・中身が薄い部分は「使わない候補」に入れています。</p>` +
    (KEEP.length
      ? KEEP.map((c, i) =>
          `<div class="clip-row"><span class="thumb"></span><span class="ch"><b>${esc(c.h)}</b><span>${c.d}・縦型</span></span><button class="clip-btn dl" data-i="${i}">⬇ DL</button></div>`).join("")
      : `<p class="placeholder">採用できる部分がありませんでした。設定を変えてやり直してみてください。</p>`);
  $("tab-trash").innerHTML =
    `<p class="reason">AIが「今回は使わない」と判断した部分です（NG・準備中・本題外）。必要なら採用に戻せます。</p>` +
    (TRASH.length
      ? TRASH.map((c, i) =>
          `<div class="clip-row trash"><span class="thumb"></span><span class="ch"><b>${esc(c.h)}</b><span>${c.r}</span></span><button class="clip-btn move" data-i="${i}">→ 採用へ</button></div>`).join("")
      : `<p class="placeholder">使わない候補はありません。</p>`);
}
// 採用候補を実 mp4 でダウンロード
function downloadClip(c) {
  const job = activeJob(); if (!job) return;
  const a = document.createElement("a");
  a.href = withTokenQuery(`/api/clips/${job.jobId}/${encodeURIComponent(c.file)}`, job.jobToken);
  a.download = c.file;
  a.click();
}
$("tab-keep").addEventListener("click", (e) => {
  const b = e.target.closest(".dl"); if (!b) return;
  const job = activeJob(); if (!job) return;
  downloadClip(job.keep[+b.dataset.i]);
});
$("tab-trash").addEventListener("click", (e) => {
  const b = e.target.closest(".move"); if (!b) return;
  const job = activeJob(); if (!job) return;
  const item = job.trash.splice(+b.dataset.i, 1)[0];
  job.keep.push({ h: item.h, d: "—" });
  renderJobList(); renderResults();
});
// 結果パネルを開く（再表示にも使う・データは保持されているので再実行不要）
function openResult() {
  const ov = $("result-overlay");
  ov.classList.remove("hidden");
  requestAnimationFrame(() => ov.classList.add("show"));
}
function fillResults(jobId, jobToken, candidates, incomplete) {
  hideEditing();              // 編集中オーバーレイを閉じる（結果パネルより前面なので先に）
  addJob(jobId, jobToken, candidates, incomplete);  // 今回の結果を履歴に積む（過去分は残る）
  renderJobList();
  renderResults();
  openResult();
  $("progress").classList.add("hidden");
  $("progress-note").classList.add("hidden");
  $("progress").querySelectorAll("li").forEach((li) => li.classList.remove("active", "done"));
  $("btn-run").disabled = false;
  $("btn-show-result").classList.remove("hidden");   // 閉じても「さっきの結果を見る」で戻れる
}
// 閉じる
function closeResult() {
  const ov = $("result-overlay");
  ov.classList.remove("show");
  setTimeout(() => ov.classList.add("hidden"), 450);
}
$("result-close").addEventListener("click", closeResult);
$("result-overlay").addEventListener("click", (e) => { if (e.target === $("result-overlay")) closeResult(); });

// 「編集済動画一覧」: 閉じた結果（履歴）を再実行なしで開き直す
$("btn-show-result").addEventListener("click", openResult);

showCut();
updateSubDesc();
refresh();
// 初期サイズチップの動画領域を反映（デバイス枠は固定のため触らない）
// requestAnimationFrame でレイアウト確定後に実行（clientWidth/Height が 0 でない保証）
requestAnimationFrame(() => {
  const activeSize = document.querySelector(".size-chip.is-on");
  if (activeSize) updateVideoArea(activeSize);
});
