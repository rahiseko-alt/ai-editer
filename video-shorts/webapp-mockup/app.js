// AI-Editer 無料版 UI — バックエンドAPI結線済み。
// POST /api/jobs → SSE /api/jobs/:id/events → GET /api/jobs/:id/candidates → DL /api/clips/:id/:file
// プレビュー正設計: デバイス枠は固定アスペクト（CSS で aspect-ratio 固定）。
// サイズ選択→.video-area の px のみを変更（contain 計算）。枠は一切変更しない。

const state = {
  file: null, sub: "none", mosaic: "none", trim: "none", breath: "",
  cut: "topic", cutMin: 3,
  size: "9:16", device: "phone",
};
const $ = (id) => document.getElementById(id);

// P1-2(A): サーバーがindex.html配信時に埋め込む起動時トークン。
// fetch系はヘッダで、EventSource/ダウンロードリンクはカスタムヘッダを付けられないためクエリで送る。
// P1-4(B): ジョブごとに発行されるjobToken(POST /api/jobsの応答)も、そのジョブ関連の呼び出し
// (SSE/候補JSON/クリップDL)すべてに併せて付与する(起動時トークンだけでは他ジョブと区別できない)。
const API_TOKEN = window.__AI_EDITOR_TOKEN__ || "";
function withTokenHeader(init = {}, jobToken = null) {
  const headers = { ...(init.headers || {}), "X-AI-Editer-Token": API_TOKEN };
  if (jobToken) headers["X-AI-Editer-Job-Token"] = jobToken;
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
// AUD-P1-13: 見た目上のアップロード枠は<label>で、リンク先の<input type=file>はhiddenのため
// クリックでしか開けなかった(Tab移動もEnter/Spaceでの起動も出来ない)。tabindex="0"で
// フォーカス可能にした上で、Enter/Spaceでもファイル選択を起動できるようにする。
drop.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" && ev.key !== " " && ev.key !== "Spacebar") return;
  ev.preventDefault();
  fileInput.click();
});
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
    // P2-7: 選んだ状態は見た目(is-on)だけでなくARIA状態(aria-pressed)も同期する。
    // 支援技術（スクリーンリーダー等）は is-on クラスを読めないため、これが無いと
    // 画面を見ずに操作する利用者に「どれを選んだか」が伝わらない。
    group.querySelectorAll(".chip").forEach((b) => {
      b.classList.remove("is-on");
      b.setAttribute("aria-pressed", "false");
    });
    btn.classList.add("is-on"); btn.setAttribute("aria-pressed", "true");
    state[g] = btn.dataset.val;
    if (g === "sub") updateSubDesc();
    if (g === "mosaic") { updateMosaicDesc(); updateMosaicStepRow(); }
    if (g === "trim") updateTrimDesc();
    if (g === "breath") updateBreathDesc();
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
function updateMosaicStepRow() {
  // モザイクを選ばないときは m の段が来ないので、進捗の行も出さない。
  const li = document.querySelector('#progress li[data-k="m"]');
  if (li) li.classList.toggle("hidden", state.mosaic !== "on");
  const es = document.querySelector('.estep[data-k="m"]');
  if (es) es.classList.toggle("hidden", state.mosaic !== "on");
}
// 選んだ内容を、専門用語を使わず1行で言い直す（何が起きるかを選ぶ前に分かるように）
function updateTrimDesc() {
  const el = $("trim-desc");
  if (!el) return;
  el.textContent = state.trim === "on"
    ? "黙っている時間と「えーと」「あのー」を詰めます。話した中身はそのまま残ります。"
    : "黙っている時間と「えーと」はそのまま残ります。";
}

// つなぎ目の間（G-EDIT-BREATH-SERVER）。「間」という言葉だけでは何が起きるか分からないので、
// 出来上がりがどう聞こえるかで言い直す。
function updateBreathDesc() {
  const el = $("breath-desc");
  if (!el) return;
  const t = {
    "": "見どころを繋いだ所に、一呼吸ぶんの間が入ります。",
    "0.4": "見どころを繋いだ所の間を短めにします。テンポよく聞こえます。",
    1: "見どころを繋いだ所の間を長めにします。ゆったり聞こえます。",
    off: "間を入れません。前の言葉が終わった瞬間に次が始まります。",
  };
  el.textContent = t[state.breath] ?? t[""];
}

function updateMosaicDesc() {
  const el = $("mosaic-desc");
  if (!el) return;
  // 「あり」を選んだときは素顔のファイルが手元に残らないことも伝える。
  // 残らないこと自体が事故防止の仕組みなので、黙って消すと不親切になる。
  el.textContent = state.mosaic === "on"
    ? "写り込んだ顔を自動で隠します。素顔のままの動画は書き出されません。"
    : "写り込んだ顔はそのまま出ます。";
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

// ── 共通モーダル制御（フォーカス管理） — P2-8 ──────────────────
// 開いたら中の最初のフォーカス可能要素へ移す(A)・Tabで外へ出さない=トラップ(B)・
// Escapeで閉じる(C)・閉じたら開く前にフォーカスしていた要素へ戻す(D)。
// マウスを使わずキーボードだけで操作する利用者や、スクリーンリーダー利用者が
// モーダルの外の要素を誤操作しない（例: 背後に隠れた「編集実行」を意図せず再度押す）ため。
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR))
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/**
 * root（モーダルの外枠要素）にフォーカストラップとEscape閉じを取り付ける。
 * onClose は Escape が押されたときに実際にモーダルを閉じる関数（表示のhidden切替を
 * アニメーション付きで行う既存のclose関数）を渡す。
 * @returns {{open: function(HTMLElement=): void, close: function(): void}}
 */
function attachModal(root, onClose) {
  let lastFocused = null;

  function handleKeydown(ev) {
    if (ev.key === "Escape") { ev.preventDefault(); onClose(); return; }
    if (ev.key !== "Tab") return;
    const focusable = getFocusable(root);
    if (focusable.length === 0) { ev.preventDefault(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (!focusable.includes(document.activeElement)) {
      // フォーカスがモーダルの外に漏れていたら、強制的に中へ戻す
      ev.preventDefault(); first.focus(); return;
    }
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault(); last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault(); first.focus();
    }
  }

  return {
    /** モーダルを開く。initialFocusEl未指定なら中の最初のフォーカス可能要素へ移す(A)。 */
    open(initialFocusEl) {
      lastFocused = document.activeElement; // 閉じたときに戻す先(D)
      root.addEventListener("keydown", handleKeydown);
      const target = initialFocusEl || getFocusable(root)[0] || root;
      // hidden解除直後はまだ表示レイアウト前のことがあるため、次のフレームで確実にフォーカスする。
      requestAnimationFrame(() => target.focus());
    },
    /** モーダルを閉じる。トラップを外し、開く前にフォーカスしていた要素へ戻す(D)。 */
    close() {
      root.removeEventListener("keydown", handleKeydown);
      if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
      lastFocused = null;
    },
  };
}

// ---- タブ（採用候補 / 使わない候補）----
// AUD-P2-24: is-on(見た目)だけでなくaria-selectedも実際に表示中のパネルと一致させる。
// これが無いと、クリックでパネルが切り替わってもスクリーンリーダーは前に選んでいた
// タブを読み上げ続ける(見た目と読み上げ内容が食い違う)。
document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.remove("is-on");
    t.setAttribute("aria-selected", "false");
  });
  tab.classList.add("is-on");
  tab.setAttribute("aria-selected", "true");
  $("tab-keep").classList.toggle("hidden", tab.dataset.tab !== "keep");
  $("tab-trash").classList.toggle("hidden", tab.dataset.tab !== "trash");
}));

// ---- 編集実行: まず中央モーダルで最終確認 → 実行する/戻る ----
const confirmModal = attachModal($("confirm-overlay"), closeConfirm);
$("btn-run").addEventListener("click", openConfirm);
function openConfirm() {
  $("confirm-summary").innerHTML = summaryHTML();
  const ov = $("confirm-overlay");
  ov.classList.remove("hidden");
  requestAnimationFrame(() => ov.classList.add("show"));
  confirmModal.open($("confirm-run")); // 初期フォーカスは「実行する」（内容確認の主動線）
}
function closeConfirm() {
  const ov = $("confirm-overlay");
  ov.classList.remove("show");
  setTimeout(() => ov.classList.add("hidden"), 300);
  confirmModal.close();
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
  c: "AIが字幕の間違いを直しています",
  s: "良い場面を選んでいます",
  r: "縦長の動画に整えています",
  m: "顔にモザイクを掛けています",
};
// 進捗ステップ（t→c→s→r→m）を編集中窓に反映。m は顔モザイクを選んだときだけサーバから来る。
// 受け皿が無いと、その工程に数分かかっている間ずっと画面が止まって見える。
const STEP_ORDER = ["t", "c", "s", "r", "m"];
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
// AUD-P2-23: 見た目はモーダルそのものだが既存のフォーカストラップ(attachModal)に
// 繋がっておらず、表示してもフォーカスは表示前の場所に残ったままだった(理由文言も
// 「別の動画を選ぶ」ボタンもキーボードで辿り着く保証が無かった)。confirm/result の
// 2モーダルと同じ仕組みに乗せ、開いたら即フォーカスを移す・Tabで外へ出さない・
// Escapeで閉じる・閉じたら元の場所へ戻す、を揃える。
const cantEditModal = attachModal($("cantedit-card"), closeCantEdit);
function showCantEdit(reason) {
  hideEditing();
  $("btn-run").disabled = false;
  $("progress").classList.add("hidden");
  if (reason) $("cantedit-reason").textContent = reason;
  const c = $("cantedit-card");
  c.classList.remove("hidden");
  requestAnimationFrame(() => c.classList.add("show"));
  cantEditModal.open($("cantedit-retry")); // 初期フォーカスは再選択の主動線
}
function hideCantEdit() {
  const c = $("cantedit-card");
  c.classList.remove("show");
  setTimeout(() => c.classList.add("hidden"), 300);
  cantEditModal.close();
}
// Escapeで閉じたとき(=attachModalのonClose)も、ボタンクリック時と同じく
// 「動画未選択」の状態へ戻す(カードだけ閉じてファイル選択済みのまま宙に浮かせない)。
function closeCantEdit() {
  hideCantEdit();
  state.file = null; $("filebar").classList.add("hidden"); $("drop").classList.remove("hidden"); refresh();
}
$("cantedit-retry").addEventListener("click", () => {
  closeCantEdit();
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
    mosaic: state.mosaic,
    trim: state.trim,
    breath: state.breath,
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
          // AUD-S-03: renderFailed(一部候補の書き出し失敗件数)もfillResultsへ渡す
          // (これまでAPI応答に居ても画面が一切読んでいなかった)。
          // AUD-S-04: digest(まとめて1本にした最終動画)もfillResultsへ渡す
          // (これまでAPI応答に居ても画面が一切読んでいなかった)。
          .then((data) => fillResults(jobId, jobToken, data.candidates || [], !!data.incomplete, data.renderFailed || 0, data.digest || null))
          .catch((msg) => showError(String(msg)));
      });

      // AUD-P1-10b: サーバーが送る業務/アプリケーションエラー(このジョブが失敗した、等)。
      // ネイティブのEventSource "error" と衝突しない専用のイベント名(job-error)で届くので、
      // ここは常に「もう続行できない終端」として扱ってよい(接続を閉じ、再接続はしない＝
      // 再接続しても同じ理由でまた失敗するだけの結果が分かっている状況のため)。
      es.addEventListener("job-error", (ev) => {
        es.close();
        let msg = "処理に失敗しました", code = null;
        try { const d = JSON.parse(ev.data); if (d.message) msg = d.message; code = d.code || null; } catch { /* ignore */ }
        if (code === "no_speech") return showCantEdit(msg);   // 専用カードへ
        showError(msg);
      });

      // P1-6: サーバー再起動でジョブの進捗(メモリのみ)が失われた場合、再接続時に届く専用イベント。
      // 「処理に失敗しました」という汎用エラーではなく、再起動が原因だと分かる文言で明示する。
      es.addEventListener("interrupted", (ev) => {
        es.close();
        let msg = "サーバーが再起動したため、処理が中断されました。もう一度実行してください。";
        try { const d = JSON.parse(ev.data); if (d.message) msg = d.message; } catch { /* ignore */ }
        showError(msg);
      });

      // AUD-P1-10a: 伝送レベルの障害(EventSourceのネイティブerror)。業務エラーは上の
      // job-errorイベントへ分離済みなので、ここへ来るのは接続そのものの問題だけになる。
      // これには2種類あり、readyStateで区別できる。
      //   ① readyState===CONNECTING: 接続済みストリームが途中で切れただけ(TCP切断・
      //      サーバー再起動の瞬間など)。ブラウザは仕様上これを検知すると自動で再接続を
      //      試みる。ここでes.close()を呼ぶとその自動再接続を握りつぶしてしまうため、
      //      何もしない(閉じない)。再接続後はサーバーが購読時に現在のスナップショットを
      //      即送る(AUD-P1-10c)ため、切断中に見逃した進捗もここで復旧する。
      //   ② readyState===CLOSED: 接続そのものを一度も確立できなかった(認可エラー等で
      //      HTTP応答が200/text-event-streamでなかった)場合、ブラウザは仕様上二度と
      //      自動再接続しない。これは打つ手が無いので、ここで明示的に終端として画面へ伝える。
      es.addEventListener("error", () => {
        if (es.readyState === EventSource.CLOSED) {
          showError("サーバーとの接続が切れました。もう一度お試しください。");
        }
        // readyState === CONNECTING の間は何もしない＝ブラウザの自動再接続に任せる。
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
function addJob(jobId, jobToken, candidates, incomplete, renderFailed, digest) {
  const keep = (candidates || []).map((c) => ({
    h: c.hook || c.keepText || "（タイトル未取得）",
    d: fmtDuration(c.duration || 0),
    file: c.file,
    // 字幕の手直しで「このクリップに写る語」だけを出すために、区間の時刻も持つ
    start: c.start,
    end: c.end,
  }));
  jobs.push({
    jobId,
    jobToken, // P1-4(B): このジョブの成果物取得に必要(クリップDL時に使う)
    label: state.file?.name || `動画${jobs.length + 1}`,
    keep,
    trash: [],   // エンジンは採用候補のみ返すため trash は空
    incomplete: !!incomplete, // P1-5: 区間選定の一部が失敗し、全編をカバーできていない場合true
    renderFailed: Number(renderFailed) || 0, // AUD-S-03: 書き出しに失敗した候補の本数
    digest: digest && digest.file ? digest : null, // AUD-S-04: まとめて1本にした最終動画(あれば)
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

// AUD-S-04: digest(まとめて1本にした最終動画)の再生・DL導線。タブの外に置くので
// 採用候補/使わない候補のどちらを見ていても常に見える。無ければ枠ごと隠す。
function renderJobDigest(job) {
  const el = $("job-digest");
  if (!job || !job.digest) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  const src = withTokenQuery(`/api/clips/${job.jobId}/${encodeURIComponent(job.digest.file)}`, job.jobToken);
  el.innerHTML =
    `<b>まとめ動画（${job.digest.parts || job.keep.length}本を1本に結合）</b>` +
    `<video controls preload="metadata" src="${esc(src)}"></video>` +
    `<div class="job-digest-actions"><a class="clip-btn dl" id="job-digest-dl" href="${esc(src)}" download="${esc(job.digest.file)}">⬇ まとめ動画をDL</a></div>`;
  el.classList.remove("hidden");
}

function renderResults() {
  const job = activeJob(); if (!job) return;
  const KEEP = job.keep, TRASH = job.trash;
  renderJobDigest(job);
  $("keep-n").textContent = KEEP.length;
  $("trash-n").textContent = TRASH.length;
  $("tab-keep").innerHTML =
    // P1-5: 一部の区間選定に失敗している場合、成功扱いに見せず必ず明示する(黙って欠落させない)。
    (job.incomplete
      ? `<p class="reason warn">⚠ 動画の一部区間の解析に失敗したため、全編ではなく成功した範囲のみから選んでいます。</p>`
      : "") +
    // AUD-S-03: 一部候補の書き出し(レンダ)自体が失敗した場合も、本数が想定より
    // 少ない理由をここで明示する(APIのJSONに数値が乗るだけでは画面に出ない=見た目上は
    // 「たまたま少なく選ばれた」ように見えてしまい、失敗の事実が伝わらない)。
    (job.renderFailed > 0
      ? `<p class="reason warn">⚠ ${job.renderFailed}件の書き出しに失敗したため、成功した${KEEP.length}件のみを表示しています。</p>`
      : "") +
    `<p class="reason">あなたの設定をもとに、AIがそのまま使える部分を${KEEP.length}本選びました。短い・中身が薄い部分は「使わない候補」に入れています。</p>` +
    (KEEP.length
      ? KEEP.map((c, i) =>
          `<div class="clip-row"><span class="thumb"></span><span class="ch"><b>${esc(c.h)}</b><span>${c.d}・縦型</span></span><button class="clip-btn cap" data-i="${i}">字幕を直す</button><button class="clip-btn dl" data-i="${i}">⬇ DL</button></div>`).join("")
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
  const cap = e.target.closest(".cap");
  if (cap) {
    const job = activeJob(); if (!job) return;
    return openCaptionEditor(job, job.keep[+cap.dataset.i]);
  }
  const b = e.target.closest(".dl"); if (!b) return;
  const job = activeJob(); if (!job) return;
  downloadClip(job.keep[+b.dataset.i]);
});

// ── 字幕の手直し（G-EDIT-CAPTION） ─────────────────────────
// 焼き込む前に文字を直せるようにする。直した内容はサーバへ保存し、
// 「この字幕で焼き直す」で作り直す。よく出る名前は用語辞書へ覚えさせる。
let capCtx = null;   // { job, clip, words }
// AUD-P1-12: 焼き直し(recaption)実行中は字幕の直しを一切保存させない(サーバ側の409と対で、
// UIレベルでも編集を明示的にロックする。ロック中に保存しようとして409を初めて知るより、
// 押せない/入力できない状態を先に見せたほうが「なぜ保存できないか」が伝わる)。
let capLocked = false;

function capStatus(text, isError) {
  const el = $("caption-status");
  el.textContent = text || "";
  el.classList.toggle("err", !!isError);
}

function openCaptionEditor(job, clip) {
  if (!job || !clip) return;
  capCtx = { job, clip, words: [] };
  capLocked = false;
  $("caption-title").textContent = `字幕を直す — ${clip.h}`;
  $("caption-editor").classList.remove("hidden");
  $("tab-keep").classList.add("hidden");
  capStatus("読み込んでいます…");
  fetch(withTokenQuery(`/api/jobs/${job.jobId}/captions`, job.jobToken),
    withTokenHeader({}, job.jobToken))
    .then((r) => (r.ok ? r.json() : r.json().then((j) => Promise.reject(new Error(j.error || `読み込みに失敗しました（${r.status}）`)))))
    .then((data) => {
      capCtx.words = (data.words || []).filter((w) =>
        clip.start === undefined || clip.end === undefined
          ? true
          : w.end > clip.start && w.start < clip.end);
      renderCaptionWords();
      capStatus("");
    })
    .catch((e) => capStatus(e.message, true));
}

function renderCaptionWords() {
  const el = $("caption-words");
  if (!capCtx || !capCtx.words.length) {
    el.innerHTML = `<p class="placeholder">この部分に字幕の文字がありません。</p>`;
    return;
  }
  // AUD-P1-12: 焼き直し中はinputへdisabledを付け、見た目でも編集できないことを示す。
  const disabledAttr = capLocked ? " disabled" : "";
  el.innerHTML = capCtx.words.map((w) =>
    `<span class="caption-word ${w.edited ? "is-edited" : ""}" data-index="${w.index}">` +
    `<input type="text" value="${esc(w.w)}" data-index="${w.index}" aria-label="字幕の語"${disabledAttr} />` +
    (w.edited ? `<span class="caption-orig">元: ${esc(w.original)}</span>` : "") +
    `</span>`).join("");
}

// 入力欄を離れたとき（またはEnter）に保存する
$("caption-words").addEventListener("change", (e) => {
  const input = e.target.closest("input[data-index]"); if (!input) return;
  // AUD-P1-12: 焼き直し中はサーバも409で拒否するが、UI側でも先に弾いて
  // 「保存できたように見えて実は反映されない」体験を避ける。
  if (capLocked) {
    capStatus("焼き直し中は字幕を直せません。焼き直しが終わってからお試しください。", true);
    renderCaptionWords();
    return;
  }
  saveCaptionWord(Number(input.dataset.index), input.value);
});
$("caption-words").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches("input[data-index]")) e.target.blur();
});

function saveCaptionWord(index, text) {
  if (!capCtx) return;
  const { job } = capCtx;
  capStatus("保存しています…");
  fetch(withTokenQuery(`/api/jobs/${job.jobId}/captions`, job.jobToken),
    withTokenHeader({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index, text }),
    }, job.jobToken))
    .then((r) => r.json().then((j) => (r.ok
      ? j
      : Promise.reject(Object.assign(new Error(j.error || "保存に失敗しました"), { status: r.status })))))
    .then((j) => {
      const w = capCtx.words.find((x) => x.index === index);
      if (w) { w.w = j.after; w.edited = j.after !== w.original; }
      renderCaptionWords();
      capStatus("保存しました");
      offerLearnTerm(j.before, j.after);
    })
    .catch((e) => {
      // AUD-P1-12: サーバがUIのロック判定より早く焼き直しを開始した(競合)場合、
      // ここで409を受け取る。保存できなかった事実を伝えつつ、UIも追随してロックする
      // (元の入力値へ戻すため再描画する＝画面上は保存されたように見えたままにしない)。
      if (e.status === 409) capLocked = true;
      renderCaptionWords();
      capStatus(e.message, true);
    });
}

// 直した語を用語辞書へ覚えさせる導線（次の案件から自動で直る）
// サーバは語の形（1語・12文字以内・予約キーでない・すでに登録済みでない）だけを見る。
// 断られた理由も、短い語への注意書きも、そのまま画面に出す。
function offerLearnTerm(before, after) {
  if (!capCtx || !before || !after || before === after) return;
  const el = $("caption-status");
  const btn = document.createElement("button");
  btn.className = "clip-btn caption-learn";
  btn.textContent = `「${before}」→「${after}」を次からも自動で直す`;
  btn.addEventListener("click", () => {
    const { job } = capCtx;
    fetch(withTokenQuery(`/api/jobs/${job.jobId}/terms`, job.jobToken),
      withTokenHeader({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ before, after }),
      }, job.jobToken))
      .then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error || "登録に失敗しました")))))
      .then((j) => capStatus(j.notice ? `次からも自動で直します。${j.notice}` : "次からも自動で直します"))
      .catch((e) => capStatus(e.message, true));
  });
  el.appendChild(document.createTextNode(" "));
  el.appendChild(btn);
}

$("caption-rebake").addEventListener("click", () => {
  if (!capCtx || capLocked) return;
  const { job } = capCtx;
  // AUD-P1-12: 焼き直し開始と同時に編集をロックする。開始直前(スナップショットを
  // 取る前)に保存されたPUTは通常どおり反映されるが、開始後のPUTはサーバ側で409に
  // なるため、その体験(押せるのに保存されない)をUI側でも先に防ぐ。
  capLocked = true;
  renderCaptionWords();
  capStatus("焼き直しています…（動画を作り直すので少し待ちます・この間は字幕を編集できません）");
  fetch(withTokenQuery(`/api/jobs/${job.jobId}/recaption`, job.jobToken),
    withTokenHeader({ method: "POST" }, job.jobToken))
    .then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error || "焼き直しに失敗しました")))))
    .then((j) => capStatus(`焼き直しました（${j.rebuilt}本）`))
    .catch((e) => capStatus(e.message, true))
    .finally(() => {
      capLocked = false;
      renderCaptionWords();
    });
});

$("caption-back").addEventListener("click", () => {
  capCtx = null;
  $("caption-editor").classList.add("hidden");
  $("tab-keep").classList.remove("hidden");
});
$("tab-trash").addEventListener("click", (e) => {
  const b = e.target.closest(".move"); if (!b) return;
  const job = activeJob(); if (!job) return;
  const item = job.trash.splice(+b.dataset.i, 1)[0];
  job.keep.push({ h: item.h, d: "—" });
  renderJobList(); renderResults();
});
// 結果パネルを開く（再表示にも使う・データは保持されているので再実行不要）
const resultModal = attachModal($("result-overlay"), closeResult);
function openResult() {
  const ov = $("result-overlay");
  ov.classList.remove("hidden");
  requestAnimationFrame(() => ov.classList.add("show"));
  resultModal.open($("result-close")); // 初期フォーカスは閉じるボタン
}
function fillResults(jobId, jobToken, candidates, incomplete, renderFailed, digest) {
  hideEditing();              // 編集中オーバーレイを閉じる（結果パネルより前面なので先に）
  addJob(jobId, jobToken, candidates, incomplete, renderFailed, digest);  // 今回の結果を履歴に積む（過去分は残る）
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
  resultModal.close();
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
