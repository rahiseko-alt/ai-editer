/*
 * AI-Editer 本番UI（ブラウザで <script src="app.js"> として素で読み込む非モジュールJS。
 * eslint.config.mjs の "ui/app.js" エントリが sourceType:"script" として検査する）。
 *
 * 以下は本ファイルが叩く REST/SSE 契約。backend-engineer-agent が実装・実機検証済みの
 * server/index.mjs（server/job-submit.mjs・server/job-events.mjs・server/media-server.mjs・
 * server/http-utils.mjs）に合わせている。この契約はサーバー側が確定させたものであり、
 * フロント側で新たに設計し直すことはしない。
 * サーバーが無い間・想定と違う応答が返ってきた間は、必ず正直にエラー状態を表示し、
 * タイマーで完了を偽装することは絶対にしない（デモ版 demo-ui との最大の違い）。
 *
 * ベースURL: 同一オリジン（server/index.mjs が ui/ の静的配信と同じオリジンで API も提供する。
 * `npm run serve` = `node server/index.mjs` で http://127.0.0.1:5178 に立ち上がる）。
 *
 * GET /api/health
 *   -> 200 { ok: true, version: string }
 *
 * POST /api/jobs  (multipart/form-data。JSON body ではない)
 *   フィールド:
 *     video              (ファイルパート, 任意。添付が無い場合はこのフィールド自体を含めない)
 *     instruction        (string, 任意。自然文の指示。空文字可)
 *     aspect             ("portrait" | "landscape", 必須)
 *     caption            ("true" | "false" の文字列, 必須)
 *     outputCount        (1〜20の整数を文字列化, 必須)
 *   -> 201 { jobId: string }
 *   -> 400（validation）/ 413（サイズ超過）/ 5xx
 *      いずれも server/http-utils.mjs の sendError() 形＝ { error: { message: string } }
 *
 * GET /api/jobs/:jobId/events  (Server-Sent Events, text/event-stream)
 *   接続直後にコメント行 ": connected"、以後15秒毎に ": ping" が届く（ブラウザ側は自動で無視）。
 *   完了/失敗すると次のいずれかの named event を1回だけ受け取り、その直後にサーバーが切断する。
 *   ネットワーク起因の接続断はブラウザが自動再接続を試みる（"待機中" として表示を続ける）。
 *
 *   event: result
 *   data: 次のいずれか（.runtime/results.jsonl の該当行をそのまま中継したもの）
 *     成功: { id: string, status: "done", output: string, at: string }
 *       // output はサーバー（メインの Claude セッション）側のローカル絶対パス。URLではない。
 *       // 再生・ダウンロードするには、ファイル名部分だけ取り出して
 *       // `/media/<jobId>/<ファイル名>` を組み立てる（下記 GET /media 参照）。
 *     失敗: { id: string, status: "error", message: string, at: string }
 *
 *   event: error
 *   data: { message: string }
 *     // results.jsonl の読み込み自体に失敗した等、配信基盤側のエラー
 *     // （job 側のエラーは上記 event:result の status:"error" 経由で届く）。
 *
 *   ※ 中間の進捗率（%）データは現状サーバーから配信されない
 *      （job-events.mjs は完了行の有無しか見ず、results.jsonl の行には output/message しか無い）。
 *      そのためUIは実際に経過した時間だけを表示し、架空の進捗率は一切表示しない。
 *      タイムライン表示は削除済み（2026-08-18 マスター指示）。
 *
 * GET /media/:jobId/:filename
 *   完成した .mp4 を配信する（Range 対応・シーク可）。<video src> にも書き出しリンクにもそのまま使える。
 *   400: jobId 形式不正・パストラバーサル試行・許可外拡張子 / 404: ファイル無し
 *
 * GET /api/jobs/:jobId/result
 *   ページ読み込み時に前回のジョブの状態を1回だけ問い合わせる（SSEと違い接続を張らない）。
 *   recoverLastJob() が localStorage の jobId を使って呼ぶ（2026-08-19: タブのリロード・
 *   別タブでの再訪問・処理が別プロセスで進む、いずれの場合も SSE 経由の状態復元はできない
 *   という事故を踏まえて追加）。
 *   -> 200 { done: true, record: <event:result の data と同じ形> }
 *   -> 200 { done: false, submittedAt: string(ISO) }   // 投入済み・処理中
 *   -> 400 / 404 / 5xx（server/http-utils.mjs の sendError() 形）
 */
(() => {
  "use strict";

  // サーバー既定の上限（server/job-submit.mjs の DEFAULT_MAX_UPLOAD_BYTES）の参考値。
  // 実際の上限は環境変数 VS_MAX_UPLOAD_BYTES で変わりうるため、ここでの判定は事前の目安に過ぎない。
  // 最終検証は常にサーバー側で行われる（UI側は過剰に作り込まない）。
  const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

  class ApiError extends Error {
    constructor(message, info) {
      super(message);
      this.name = "ApiError";
      this.network = Boolean(info && info.network);
      this.status = info ? info.status : undefined;
    }
  }

  async function apiFetch(path, options) {
    let res;
    try {
      res = await fetch(path, options);
    } catch (err) {
      throw new ApiError(
        "サーバーに接続できません。バックエンドが起動しているか確認してください。",
        { network: true, cause: err },
      );
    }
    const text = await res.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (_parseErr) {
        body = null;
      }
    }
    if (!res.ok) {
      const message =
        body && body.error && body.error.message
          ? body.error.message
          : `サーバーエラー（HTTP ${res.status}）`;
      throw new ApiError(message, { status: res.status, cause: body });
    }
    return body;
  }

  // --- 要素取得 ---
  const offlineBanner = document.getElementById("offlineBanner");
  const offlineBannerText = document.getElementById("offlineBannerText");
  const retryHealthBtn = document.getElementById("retryHealthBtn");
  const serverStatus = document.getElementById("serverStatus");
  const fullscreenBtn = document.getElementById("fullscreenBtn");
  const exportBtn = document.getElementById("exportBtn");
  const transcriptBtn = document.getElementById("transcriptBtn");
  const transcriptOverlay = document.getElementById("transcriptOverlay");
  const transcriptBody = document.getElementById("transcriptBody");
  const transcriptCloseBtn = document.getElementById("transcriptCloseBtn");

  const dropZone = document.getElementById("dropZone");
  const fileInput = document.getElementById("fileInput");
  const clipList = document.getElementById("clipList");

  const stage = document.getElementById("stage");
  const stageEmpty = document.getElementById("stageEmpty");
  const player = document.getElementById("player");

  const outputTabs = document.getElementById("outputTabs");
  const applyReport = document.getElementById("applyReport");

  const instructionForm = document.getElementById("instructionForm");
  const instructionInput = document.getElementById("instructionInput");
  const runBtn = document.getElementById("runBtn");
  const runHint = document.getElementById("runHint");

  const aspectButtons = Array.from(document.querySelectorAll("[data-aspect]"));
  const captionSwitch = document.getElementById("captionSwitch");

  const overlay = document.getElementById("overlay");
  const stageName = document.getElementById("stageName");
  const stageSub = document.getElementById("stageSub");
  const overlayActions = document.getElementById("overlayActions");
  const overlayCloseBtn = document.getElementById("overlayCloseBtn");
  const cancelJobBtn = document.getElementById("cancelJobBtn");
  const progressCard = overlay.querySelector(".progress-card");

  const toast = document.getElementById("toast");
  const toastText = document.getElementById("toastText");

  // --- 状態 ---
  let materials = [];
  let activeMaterial = null;
  let currentAspect = "landscape";
  // 出力本数はサーバー側の完了通知契約（results.jsonl は単一 output のみ運べる）に合わせ、
  // 常に1本固定とする（UI選択は削除。将来複数出力に対応する場合は契約ごと再設計する）。
  const OUTPUT_COUNT = 1;
  let job = null; // { id, status, result: { videoUrl, segments } | null }
  let jobEventSource = null;
  let jobStartedAt = null;
  let elapsedTimer = null;
  let serverOnline = null;
  let toastTimer = null;

  // サーバー完全ダウン時、EventSource は CONNECTING を繰り返すだけで CLOSED に到達しない
  // （＝onerror の readyState===CLOSED 待ちだと永遠に「処理中」表示のままになる）。
  // そのため、接続確立(onopen)前の onerror が一定回数連続した場合、または接続開始から
  // 一定時間しても onopen が起きない場合は、CLOSED を待たずに正直なエラー表示へ切り替える。
  const CONNECT_ERROR_STREAK_LIMIT = 3;
  const CONNECT_TIMEOUT_MS = 15000;
  let connectOpened = false;
  let errorStreak = 0;
  let connectTimeoutTimer = null;

  // --- 直近ジョブの復元（localStorage） ---
  // 2026-08-19の事故: SSEは「投入したタブが開いたまま」前提に依存しており、リロード・別タブでは
  // job-eventSource受信の起点となる jobId 自体がJS変数（モジュールスコープのクロージャ）ごと消える。
  // jobId だけを覚えておき、読み込み時にサーバーへ1回問い合わせて状態を復元する（recoverLastJob）。
  const LAST_JOB_STORAGE_KEY = "vs.lastJob";

  function saveLastJob(jobId) {
    try {
      localStorage.setItem(LAST_JOB_STORAGE_KEY, JSON.stringify({ jobId }));
    } catch (_err) {
      // プライベートモード等で localStorage が使えなくても、通常の投入・SSE受信フローは
      // 影響を受けない（復元機能だけを諦める）。
    }
  }

  function loadLastJobId() {
    try {
      const raw = localStorage.getItem(LAST_JOB_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed.jobId === "string" ? parsed.jobId : null;
    } catch (_err) {
      return null;
    }
  }

  // jobId が一致する場合だけ消す。無条件の removeItem() だと、別タブが直後に新しいジョブを
  // 保存した直後に古い復元処理がそれを巻き添えで消してしまう競合が起きうるため。
  function clearLastJobIfMatches(jobId) {
    try {
      const raw = localStorage.getItem(LAST_JOB_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.jobId === jobId) localStorage.removeItem(LAST_JOB_STORAGE_KEY);
    } catch (_err) {
      // 壊れた値は判断できない場合は消さずに放置する（loadLastJobId側のtry/catchが
      // 同じく null 扱いにするので、動作上は無害）。
    }
  }

  // --- サーバー疎通確認 ---
  async function checkHealth() {
    serverStatus.textContent = "確認中…";
    serverStatus.className = "server-status";
    try {
      await apiFetch("/api/health");
      serverOnline = true;
      serverStatus.textContent = "サーバー接続OK";
      serverStatus.className = "server-status online";
      offlineBanner.hidden = true;
    } catch (err) {
      serverOnline = false;
      serverStatus.textContent = "サーバー未接続";
      serverStatus.className = "server-status offline";
      offlineBanner.hidden = false;
      offlineBannerText.textContent = err.message;
    }
  }
  retryHealthBtn.addEventListener("click", checkHealth);

  // --- 素材の追加（この時点ではサーバーへは送らない。実行時にまとめて送信する） ---
  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    handleFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener("change", () => {
    handleFiles(fileInput.files);
    fileInput.value = "";
  });

  function handleFiles(fileList) {
    Array.from(fileList).forEach((f) => {
      if (!f.type.startsWith("video/")) {
        showToast(`「${f.name}」は動画ファイルではないため追加できません`, true);
        return;
      }
      if (f.size > MAX_UPLOAD_BYTES) {
        showToast(`「${f.name}」はサイズが大きすぎるため追加できません（目安の上限 2GB）`, true);
        return;
      }
      addMaterial(f);
    });
  }

  function addMaterial(file) {
    const material = {
      clientId: crypto.randomUUID(),
      file,
      url: URL.createObjectURL(file),
      name: file.name,
      durationSec: null,
    };
    materials.push(material);
    renderClipList();
    selectMaterial(material);
    probeLocalMetadata(material);
  }

  function probeLocalMetadata(material) {
    // サムネイル・尺はローカルでも即座に分かるので、サーバー応答を待たずに表示する。
    const tmp = document.createElement("video");
    tmp.src = material.url;
    tmp.muted = true;
    tmp.addEventListener("loadedmetadata", () => {
      if (material.durationSec === null) material.durationSec = tmp.duration;
      tmp.currentTime = Math.min(1, tmp.duration / 2);
    });
    tmp.addEventListener(
      "seeked",
      () => {
        const canvas = clipList.querySelector(`canvas[data-client-id="${material.clientId}"]`);
        if (canvas) {
          canvas.width = 104;
          canvas.height = 64;
          canvas.getContext("2d").drawImage(tmp, 0, 0, canvas.width, canvas.height);
        }
        renderClipList();
      },
      { once: true },
    );
  }

  function fmtDur(sec) {
    if (sec === null || Number.isNaN(sec)) return "--:--";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  function escapeHtml(s) {
    return s.replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }

  function renderClipList() {
    clipList.innerHTML = "";
    materials.forEach((material) => {
      const li = document.createElement("li");
      const card = document.createElement("button");
      card.type = "button";
      const isActive = Boolean(activeMaterial && activeMaterial.clientId === material.clientId);
      card.className = "clip-card" + (isActive ? " active" : "");
      if (isActive) card.setAttribute("aria-current", "true");
      card.innerHTML = `<canvas data-client-id="${material.clientId}"></canvas>
        <div class="clip-meta">
          <div class="name">${escapeHtml(material.name)}</div>
          <div class="dur">${fmtDur(material.durationSec)}</div>
        </div>`;
      card.addEventListener("click", () => selectMaterial(material));
      li.appendChild(card);
      clipList.appendChild(li);
    });
  }

  function selectMaterial(material) {
    activeMaterial = material;
    player.src = material.url;
    player.style.display = "block";
    stageEmpty.style.display = "none";
    resetTimeline();
    renderClipList();
  }

  function resetTimeline() {
    closeJobEvents();
    job = null;
    outputTabs.hidden = true;
    outputTabs.innerHTML = "";
    clearApplyReport();
    exportBtn.disabled = true;
    transcriptBtn.disabled = true;
    transcriptOverlay.hidden = true;
  }

  function clearApplyReport() {
    applyReport.hidden = true;
    applyReport.innerHTML = "";
  }

  /**
   * 「この指示で編集しました／反映した内容／反映できなかった項目」を出す。
   * 反映できなかった項目こそが要点なので、1件も無いときでも「全部反映した」と明言する
   * （空欄のままだと、報告が出ていないのか反映漏れが無いのか区別できない）。
   */
  function renderApplyReport(data) {
    const instruction = typeof data.instruction === "string" ? data.instruction : "";
    const applied = Array.isArray(data.applied) ? data.applied : [];
    const notApplied = Array.isArray(data.notApplied) ? data.notApplied : [];

    const listHtml = (items, cls) =>
      `<ul class="${cls}">${items.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>`;

    let html = "<h3>この指示で編集しました</h3>";
    html += instruction
      ? `<p class="said">${escapeHtml(instruction)}</p>`
      : `<p class="said none">（指示なし。自動で判断しました）</p>`;

    html +=
      `<button type="button" class="apply-report-toggle" id="applyReportToggle" ` +
      `aria-expanded="false" aria-controls="applyReportDetails">` +
      `<span class="chev" aria-hidden="true">▽</span>反映した内容</button>`;

    let details = "";
    if (applied.length) {
      details += listHtml(applied, "hit");
    }
    if (notApplied.length) {
      details += "<h3>反映できなかった項目</h3>" + listHtml(notApplied, "miss");
    } else if (instruction) {
      details += `<h3>反映できなかった項目</h3><p class="said none">ありません（指示はすべて反映しました）</p>`;
    }
    html += `<div class="apply-report-details" id="applyReportDetails" hidden>${details}</div>`;

    applyReport.innerHTML = html;
    applyReport.hidden = false;
  }

  // 反映内容パネルはrenderApplyReportのたびにDOMが作り直される（トグルボタンも毎回新規要素）ため、
  // ボタン個別ではなく静的な親要素applyReportへイベント委任で1回だけ登録する。
  applyReport.addEventListener("click", (e) => {
    const toggle = e.target.closest("#applyReportToggle");
    if (!toggle) return;
    const details = document.getElementById("applyReportDetails");
    if (!details) return;
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    details.hidden = expanded;
  });

  // --- 縦横比 ---
  aspectButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      aspectButtons.forEach((b) => b.setAttribute("aria-pressed", "false"));
      btn.setAttribute("aria-pressed", "true");
      currentAspect = btn.dataset.aspect;
      stage.classList.toggle("v-portrait", currentAspect === "portrait");
      stage.classList.toggle("v-landscape", currentAspect === "landscape");
    });
  });

  // --- 字幕スイッチ ---
  captionSwitch.addEventListener("click", () => {
    const on = !captionSwitch.classList.contains("on");
    captionSwitch.classList.toggle("on", on);
    captionSwitch.setAttribute("aria-checked", String(on));
  });

  // 【2026-08-19 削除】「目標の尺」の入力欄。マスター判断で撤去した。
  // 必須の数値目標だったため、AI が意味の完結より尺合わせを優先していた
  // （判断ログに「60秒に収めるため具体例と使い方説明を落とし」等が残っている）。
  // 尺を指定したいときは指示欄に「1分半で」と書く。docs/failures.md 2026-08-19 の項。

  // --- 全画面 ---
  fullscreenBtn.addEventListener("click", () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  });

  // --- 実行（動画添付の有無に関わらず、このボタン1つがすべてのトリガー） ---
  instructionForm.addEventListener("submit", (e) => {
    e.preventDefault();
    runJob();
  });

  function closeJobEvents() {
    if (jobEventSource) {
      jobEventSource.close();
      jobEventSource = null;
    }
    clearTimeout(connectTimeoutTimer);
    connectTimeoutTimer = null;
    stopElapsedTimer();
  }

  function stopElapsedTimer() {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  function elapsedLabelText() {
    if (!jobStartedAt) return "";
    const sec = Math.max(0, Math.round((Date.now() - jobStartedAt) / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}分${s}秒経過` : `${s}秒経過`;
  }

  // 2026-08-19: 以前ここは「完了まで数分かかることがあります」と出していた。実際は
  // 文字起こしのあと AI が「どこを使うか」を内容を読んで決めるため、10〜30分かかる。
  // この乖離のせいでマスターが「固まった」と判断して中止を押し、prepare 済みのジョブが
  // 1本無駄になった（docs/failures.md 参照）。かかる時間と、進行がどこに出るかを正直に書く。
  function tickElapsed() {
    if (!job || !job.id) {
      setOverlayState("processing", "送信しています", elapsedLabelText());
    } else {
      // マスター指示（2026-08-19）: 表示は経過時間・「編集中」・「中止」の3つだけにする。
      // 所要時間の目安や「進行は別画面に出る」という説明（docs/failures.md の事故を受けて
      // 追加したもの）は表示からは外すが、経緯はこのコメントに残す。
      setOverlayState("processing", "編集中", elapsedLabelText());
    }
  }

  async function runJob() {
    runHint.textContent = "";
    if (serverOnline === false) {
      runHint.textContent = "サーバーに接続できません。接続を確認してから再度お試しください。";
      checkHealth();
      return;
    }
    if (!activeMaterial && !instructionInput.value.trim()) {
      runHint.textContent = "動画を追加するか、指示を入力してください。";
      return;
    }
    const form = new FormData();
    if (activeMaterial) form.append("video", activeMaterial.file, activeMaterial.name);
    form.append("instruction", instructionInput.value.trim());
    form.append("aspect", currentAspect);
    form.append("caption", captionSwitch.classList.contains("on") ? "true" : "false");
    form.append("outputCount", String(OUTPUT_COUNT));

    closeJobEvents();
    job = { id: null, status: "queued", result: null };
    jobStartedAt = Date.now();
    showOverlay();
    setOverlayState("processing", "送信しています", "動画とご指示をサーバーへ送信しています。");
    elapsedTimer = setInterval(tickElapsed, 1000);

    runBtn.disabled = true;
    try {
      const body = await apiFetch("/api/jobs", { method: "POST", body: form });
      job.id = body.jobId;
      job.status = "queued";
      saveLastJob(body.jobId);
      startJobEvents(body.jobId);
    } catch (err) {
      stopElapsedTimer();
      setOverlayState("error", "実行できませんでした", err.message);
    } finally {
      runBtn.disabled = false;
    }
  }

  // --- 進捗・完了通知の受信（SSE。中間の進捗率は配信されないため、経過時間のみを正直に表示する） ---
  function startJobEvents(jobId) {
    if (jobEventSource) {
      jobEventSource.close();
      jobEventSource = null;
    }
    const es = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
    jobEventSource = es;
    connectOpened = false;
    errorStreak = 0;
    clearTimeout(connectTimeoutTimer);
    connectTimeoutTimer = setTimeout(() => {
      if (jobEventSource !== es || connectOpened) return;
      handleConnectionUnreachable(jobId);
    }, CONNECT_TIMEOUT_MS);

    es.addEventListener("open", () => {
      connectOpened = true;
      errorStreak = 0;
      clearTimeout(connectTimeoutTimer);
    });

    es.addEventListener("result", (evt) => {
      if (!job || job.id !== jobId) return;
      closeJobEvents();
      let data = null;
      try {
        data = JSON.parse(evt.data);
      } catch (_parseErr) {
        data = null;
      }
      onJobResult(data);
    });

    es.addEventListener("error", (evt) => {
      if (!job || job.id !== jobId) {
        es.close();
        return;
      }
      if (evt.data) {
        // サーバーが明示的に送った `event: error`（構造化エラー）。
        closeJobEvents();
        let msg = "不明なエラーです。";
        try {
          const body = JSON.parse(evt.data);
          if (body && body.message) msg = body.message;
        } catch (_parseErr) {
          // noop
        }
        setOverlayState("error", "処理に失敗しました", msg);
        return;
      }
      if (es.readyState === EventSource.CLOSED) {
        // ブラウザの自動再接続も尽きた、実際の接続断。
        closeJobEvents();
        setOverlayState(
          "error",
          "サーバーとの接続が切れました",
          "ネットワークまたはサーバーの状態を確認し、もう一度お試しください。",
        );
        return;
      }
      // readyState が CONNECTING の間はブラウザが自動再接続を試み続け、CLOSED には
      // 到達しないことがある（サーバーが完全停止している場合など）。そのままだと
      // 「処理中」表示が無期限に固まって見えてしまうため、連続エラー回数でも判定する。
      errorStreak += 1;
      if (!connectOpened && errorStreak >= CONNECT_ERROR_STREAK_LIMIT) {
        handleConnectionUnreachable(jobId);
      }
    });
  }

  function handleConnectionUnreachable(jobId) {
    if (!job || job.id !== jobId) return;
    closeJobEvents();
    setOverlayState(
      "error",
      "サーバーに接続できません",
      "バックエンドが起動しているか確認し、もう一度お試しください。",
    );
  }

  /**
   * サーバー（メインの Claude セッション）側のローカル絶対パスから、ファイル名部分だけを
   * 取り出す。Windows パス（\ 区切り）・POSIX パス（/ 区切り）のどちらでも動くようにする。
   */
  function basenameFromPath(p) {
    if (typeof p !== "string" || p === "") return "";
    const normalized = p.replace(/\\/g, "/");
    const parts = normalized.split("/");
    return parts[parts.length - 1] || "";
  }

  function onJobResult(data) {
    if (!data || typeof data !== "object") {
      setOverlayState("error", "処理に失敗しました", "サーバーからの応答を解釈できませんでした。");
      return;
    }
    if (data.status === "error") {
      setOverlayState("error", "処理に失敗しました", data.message || "不明なエラーです。");
      return;
    }
    const filename = basenameFromPath(data.output);
    if (!filename) {
      setOverlayState("error", "処理に失敗しました", "サーバーから完成動画のパスを取得できませんでした。");
      return;
    }
    const videoUrl = `/media/${encodeURIComponent(job.id)}/${encodeURIComponent(filename)}`;
    job.result = { videoUrl };
    hideOverlay();
    player.src = videoUrl;
    player.style.display = "block";
    stageEmpty.style.display = "none";
    exportBtn.disabled = false;
    transcriptBtn.disabled = false;
    renderApplyReport(data);
    showToast("処理が完了しました");
  }

  // --- ダウンロード（サーバー側では別工程を起動しない。完成済みの動画を取得するだけ） ---
  exportBtn.addEventListener("click", () => {
    if (!job || !job.result || !job.result.videoUrl) {
      showToast("ダウンロードできる完成動画がありません", true);
      return;
    }
    const a = document.createElement("a");
    a.href = job.result.videoUrl;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast("ダウンロードを開始しました");
  });

  // --- 文字起こし（編集前）表示。transcript.json をそのまま平文で見せるだけで、
  // 編集後の内容には一切影響しない読み取り専用の確認機能。 ---
  transcriptBtn.addEventListener("click", async () => {
    if (!job || !job.id) {
      showToast("文字起こしがありません", true);
      return;
    }
    transcriptBody.textContent = "読み込み中…";
    transcriptOverlay.hidden = false;
    try {
      const data = await apiFetch(`/api/jobs/${encodeURIComponent(job.id)}/transcript`);
      transcriptBody.textContent = data && data.text ? data.text : "（文字起こしが空です）";
    } catch (err) {
      transcriptBody.textContent = err instanceof ApiError ? err.message : "取得に失敗しました。";
    }
  });
  transcriptCloseBtn.addEventListener("click", () => {
    transcriptOverlay.hidden = true;
  });

  // --- オーバーレイ（進捗・エラー表示。タイマーでの偽装は行わず、常に実イベント/実経過時間を反映する） ---
  function showOverlay() {
    overlay.hidden = false;
  }
  function hideOverlay() {
    overlay.hidden = true;
  }
  function setOverlayState(kind, title, sub) {
    progressCard.classList.toggle("error", kind === "error");
    stageName.textContent = title;
    stageSub.textContent = sub || "";
    overlayActions.hidden = kind !== "error";
  }
  overlayCloseBtn.addEventListener("click", hideOverlay);

  // --- 中止（サーバーへ中止依頼を送りつつ、応答を待たずにUI側を即座に処理前の状態へ戻す） ---
  cancelJobBtn.addEventListener("click", async () => {
    const cancellingId = job && job.id;
    closeJobEvents();
    stopElapsedTimer();
    hideOverlay();
    job = null;
    runBtn.disabled = false;
    showToast("中止しました");
    if (cancellingId) {
      clearLastJobIfMatches(cancellingId);
      try {
        await apiFetch(`/api/jobs/${encodeURIComponent(cancellingId)}/cancel`, { method: "POST" });
      } catch {
        // サーバー側の中止依頼が失敗しても、UIは既に処理前の状態に戻っているので何もしない。
      }
    }
  });

  function showToast(text, isError) {
    toastText.textContent = text;
    toast.classList.toggle("error", Boolean(isError));
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
  }

  // --- 前回ジョブの復元（ページ読み込み時に1回だけ） ---
  async function recoverLastJob() {
    const jobId = loadLastJobId();
    if (!jobId) return;

    let body;
    try {
      body = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}/result`);
    } catch (err) {
      // 待っている間にユーザーが既に何か（新規投入等）を始めていたら、絶対にそれを上書きしない。
      if (job !== null) return;
      if (!(err instanceof ApiError) || !err.network) {
        // サーバーは応答したが、この jobId を知らない（400: 形式不正 / 404: 記録なし）。
        // .runtime 掃除後の古い参照等。実害の無い状況なので、静かに消して通常の空表示に戻す
        // （マスターが古いページを開いただけで怖いエラーを見せない）。
        clearLastJobIfMatches(jobId);
      }
      // ネットワークエラー（サーバー未起動）の場合は判断材料が無いので何もしない。
      // 次回の読み込みや「再接続」操作で改めて復元を試みる。
      return;
    }

    if (job !== null) return; // 同上：待っている間にユーザーが既に新しい操作を始めていた

    if (body && body.done) {
      // job-events.mjs の event:result と全く同じデータ形なので、同じ関数へそのまま渡す
      // （DOM操作ロジックを重複させない）。
      job = { id: jobId, status: "queued", result: null };
      showOverlay();
      onJobResult(body.record);
      return;
    }

    // まだ完了していない＝処理中。SSEを再開して完了を待つ。
    // 経過時間は「今」からではなく、サーバーが記録している本当の投入時刻（chat-inbox.jsonl の
    // at）から計算する。リロードした瞬間から0秒で数え直すのは実態と異なる嘘の表示になる
    // （タイマーで完了を偽装することは絶対にしない、という本ファイルの方針に反する）。
    job = { id: jobId, status: "queued", result: null };
    jobStartedAt = body && body.submittedAt ? Date.parse(body.submittedAt) : null;
    showOverlay();
    setOverlayState("processing", "編集中", elapsedLabelText());
    elapsedTimer = setInterval(tickElapsed, 1000);
    startJobEvents(jobId);
  }

  // --- 初期化 ---
  checkHealth();
  recoverLastJob();
})();
