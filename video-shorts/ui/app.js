// video-shorts [7] 選別UI ロジック — candidates.json を読み込み、各候補を採用/破棄。
// 動画は candidates.json と同じフォルダ基準で参照する（file://でも動くよう相対解決）。

const state = {
  jobId: null,
  baseUrl: null, // candidates.json のあるフォルダ URL
  candidates: [],
};

const els = {
  input: document.getElementById("manifest-input"),
  grid: document.getElementById("grid"),
  empty: document.getElementById("empty-msg"),
  jobLabel: document.getElementById("job-label"),
  counts: document.getElementById("counts"),
  exportBtn: document.getElementById("export-btn"),
  tpl: document.getElementById("card-tpl"),
};

els.input.addEventListener("change", onFileSelected);
els.exportBtn.addEventListener("click", exportAdopted);

// 起動時に ?job=<id> パラメータから ../output/<id>/candidates.json を自動ロード。
// パラメータ無しの場合は手動ボタンを使う。
autoLoad();
async function autoLoad() {
  const job = new URLSearchParams(location.search).get("job");
  if (!job) return;
  try {
    const jsonPath = `../output/${job}/candidates.json`;
    const res = await fetch(jsonPath, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    state.jobId = data.id || job;
    state.candidates = (data.candidates || []).map((c) => ({ ...c, status: "pending" }));
    state.baseUrl = `../output/${job}`;
    render();
  } catch (_) {
    // fetch 不可 → 手動ファイル選択にフォールバック
  }
}

function onFileSelected(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      // file:// では同フォルダの mp4 を相対参照する。webkitRelativePath が無いため
      // ユーザーが UI を output/<id>/ 配下に置くか、mp4 を別途読ませる運用を許容。
      state.jobId = data.id || "(unknown)";
      state.candidates = (data.candidates || []).map((c) => ({ ...c, status: "pending" }));
      state.baseUrl = "."; // index.html と同階層に candidates.json/mp4 を置く想定
      render();
    } catch (err) {
      alert("candidates.json の読み込みに失敗: " + err.message);
    }
  };
  reader.readAsText(file);
}

function render() {
  els.empty.style.display = "none";
  els.grid.querySelectorAll(".card").forEach((n) => n.remove());
  els.jobLabel.textContent = `job: ${state.jobId} / ${state.candidates.length} 候補`;

  state.candidates.forEach((c, idx) => {
    const node = els.tpl.content.cloneNode(true);
    const card = node.querySelector(".card");
    const video = node.querySelector(".clip");
    video.src = `${state.baseUrl}/${c.file}`;
    node.querySelector(".hook").textContent = c.hook || "(hookなし)";
    node.querySelector(".time").textContent =
      `${fmt(c.start)}–${fmt(c.end)} (${Math.round(c.duration)}s)`;
    node.querySelector(".conf").textContent = (c.confidence ?? 0).toFixed(2);
    node.querySelector(".keep").textContent = c.keepText || "";
    if (!c.vertical) {
      const badge = node.querySelector(".badge");
      badge.textContent = "⚠ 非縦型";
    }
    node.querySelector(".adopt").addEventListener("click", () => setStatus(idx, "adopt", card));
    node.querySelector(".reject").addEventListener("click", () => setStatus(idx, "reject", card));
    els.grid.appendChild(node);
  });
  updateCounts();
}

function setStatus(idx, status, card) {
  // 同じボタン再クリックで pending に戻す（トグル）
  state.candidates[idx].status =
    state.candidates[idx].status === status ? "pending" : status;
  card.dataset.status = state.candidates[idx].status;
  updateCounts();
}

function updateCounts() {
  const a = state.candidates.filter((c) => c.status === "adopt").length;
  const r = state.candidates.filter((c) => c.status === "reject").length;
  const p = state.candidates.length - a - r;
  els.counts.textContent = `採用 ${a} / 破棄 ${r} / 未判定 ${p}`;
  els.exportBtn.disabled = a === 0;
}

function exportAdopted() {
  const adopted = state.candidates
    .filter((c) => c.status === "adopt")
    .map(({ index, file, start, end, duration, hook }) => ({ index, file, start, end, duration, hook }));
  const blob = new Blob([JSON.stringify({ id: state.jobId, adopted }, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `adopted-${state.jobId}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
