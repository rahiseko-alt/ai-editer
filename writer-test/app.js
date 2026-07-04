'use strict';

// kosespark Writer テスト版 — フロント挙動のみ。
// 裏のエンジン（Tavily / 執筆 / textlint / Marp）の実配線は未接続。
// 「生成」は工程の流れとサンプル表示で体験を見せる段階。

const $ = (s) => document.querySelector(s);
const $all = (s) => Array.from(document.querySelectorAll(s));

const runBtn = $('#run');
const pipeline = $('#pipeline');
const empty = $('#empty');

const STEPS = ['research', 'write', 'proof', 'slide'];

// ---- タブ切り替え ----
$all('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $all('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const name = tab.dataset.tab;
    $all('.tab-body').forEach((b) => { b.hidden = (b.dataset.body !== name); });
  });
});

function setStep(step, state) {
  const el = pipeline.querySelector(`[data-step="${step}"]`);
  el.classList.remove('run', 'done');
  if (state) el.classList.add(state);
}

function resetPipeline() {
  STEPS.forEach((s) => setStep(s, null));
}

// ---- 生成（テスト版：工程演出＋サンプル）----
runBtn.addEventListener('click', async () => {
  const kw = $('#f-keyword').value.trim();
  if (!kw) { $('#f-keyword').focus(); return; }

  runBtn.classList.add('busy');
  runBtn.textContent = '生成中…';
  resetPipeline();
  empty.hidden = true;
  $all('.tab-body').forEach((b) => { b.hidden = true; b.innerHTML = ''; });

  // 工程を順に進める（体験の可視化）
  for (let i = 0; i < STEPS.length; i++) {
    setStep(STEPS[i], 'run');
    await wait(900);
    setStep(STEPS[i], 'done');
  }

  renderSample(kw);

  runBtn.classList.remove('busy');
  runBtn.textContent = '記事を生成する';
});

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---- サンプル描画（テスト版・固定文面）----
function renderSample(kw) {
  const persona = $('#f-persona').value.trim() || '初心者';

  const article = $('[data-body="article"]');
  article.hidden = false;
  $('.tab').classList.add('active');
  article.innerHTML = `
    <div class="titles">
      <b>★ タイトル案</b>　${escapeHtml(kw)}を${escapeHtml(persona)}向けにやさしく解説<br>
      <span style="color:#777">テスト版サンプル — 実際は執筆AIが本文を生成し、textlintが校正します</span>
    </div>
    <h2>${escapeHtml(kw)}</h2>
    <p>これは <b>kosespark Writer テスト版</b> の表示サンプルです。本番では、左で入力したテーマ「${escapeHtml(kw)}」をもとに、リサーチAI（Tavily）が下調べし、執筆AIが本文を書き、校正AI（textlint）が仕上げます。</p>
    <h3>このツールの流れ</h3>
    <p>上のバーが示すとおり、調査 → 執筆 → 校正 → スライドの順に、それぞれ専門のAI/ツールが担当します。あなたは中の仕組みを知らなくて大丈夫です。</p>
    <h3>注記</h3>
    <p>現在はフロント画面の動作確認段階です。<span class="tag">未接続</span> の工程は、この後エンジンに配線します。</p>
  `;

  const slide = $('[data-body="slide"]');
  slide.innerHTML = `
    <div class="slide-deck">
      <div class="slide-card"><span class="num">Slide 1</span><h4>${escapeHtml(kw)}</h4><p>クライアント提出用・制作過程の説明資料（Marpで生成）</p></div>
      <div class="slide-card"><span class="num">Slide 2</span><h4>制作の流れ</h4><p>① 調査 ② 執筆 ③ 校正 ④ スライド化</p></div>
      <div class="slide-card"><span class="num">Slide 3</span><h4>使ったAI</h4><p>Tavily / 執筆AI / textlint / Marp</p></div>
    </div>
    <p class="run-note">テスト版サンプル。本番は Marp が .pdf / .pptx を出力します。</p>
  `;

  const src = $('[data-body="source"]');
  src.innerHTML = `
    <ul class="src-list">
      <li>テスト版サンプル — 本番ではリサーチAIが収集した出典URLがここに並びます</li>
      <li><a>例）公式ドキュメント・一次情報のリンク</a></li>
    </ul>
  `;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
