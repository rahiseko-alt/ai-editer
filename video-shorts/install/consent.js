// video-shorts 同意→ダウンロード（Web配布・署名不要）。
// - お名前入力 + 同意チェックで「同意してダウンロード（Next）」を活性化
// - Next 押下で、製品ファイル（video-shorts.zip）を実際にダウンロードする
// - 同意の控えは任意：署名者が自分のメールから運営宛に送れば記録として保管できる（署名・郵送不要）
(function () {
  "use strict";
  const card = document.querySelector(".card");
  const nameEl = document.getElementById("name");
  const agreeEl = document.getElementById("agree");
  const startEl = document.getElementById("start");
  const hintEl = document.getElementById("hint");
  const receiptEl = document.getElementById("receipt");
  const receiptText = document.getElementById("receiptText");
  const sendmailEl = document.getElementById("sendmail");
  const downloadEl = document.getElementById("download");
  const mailnoteEl = document.getElementById("mailnote");
  const contactShowEl = document.getElementById("contactShow");
  const productShowEl = document.getElementById("productShow");
  const productLinkEl = document.getElementById("productLink");
  const termsEl = document.getElementById("terms");

  const VERSION = card.dataset.consentVersion || "1.0";
  const CONSENT_DATE = card.dataset.consentDate || "";
  const CONTRACT = card.dataset.contract || "";
  const CONTACT = card.dataset.contact || "";
  const PRODUCT = card.dataset.product || "video-shorts.zip";
  // AUD-P1-14: 確定本文が閲覧できない契約に同意させないためのゲート。
  // data-contract-available が明示的に "false" でない限り有効（既定は利用可能側に寄せない＝安全側）。
  const CONTRACT_AVAILABLE = card.dataset.contractAvailable !== "false";

  if (contactShowEl) contactShowEl.textContent = CONTACT;
  if (productShowEl) productShowEl.textContent = PRODUCT;
  if (productLinkEl) productLinkEl.setAttribute("href", PRODUCT);

  // 文言のフィンガープリント（FNV-1a 32bit）。静的ホスティングでも動くよう SubtleCrypto は使わない。
  function fingerprint(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return "fnv1a:" + (h >>> 0).toString(16).padStart(8, "0");
  }
  function normalize(s) { return (s || "").replace(/\s+/g, " ").trim(); }
  function pad(n) { return String(n).padStart(2, "0"); }
  function stamp(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  function refresh() {
    // AUD-P1-14: #agree はHTML側で既定 disabled（安全側）。確定本文が用意され
    // data-contract-available が "false" 以外になった時点で、ここで実際に有効化する
    // (これを書かないと、将来フラグを立てても静的disabledが残ったまま同意操作が
    // 永久に完了できなくなる)。
    agreeEl.disabled = !CONTRACT_AVAILABLE;
    agreeEl.setAttribute("aria-disabled", CONTRACT_AVAILABLE ? "false" : "true");
    if (!CONTRACT_AVAILABLE) {
      // 確定本文が無い間は、名前・チェックの状態にかかわらず同意操作自体を許可しない。
      startEl.disabled = true;
      hintEl.textContent = "「" + CONTRACT + "」の確定本文が未掲載のため、現在は同意・ダウンロードできません。";
      return;
    }
    const ok = nameEl.value.trim().length > 0 && agreeEl.checked;
    startEl.disabled = !ok;
    hintEl.textContent = ok
      ? "「同意してダウンロード」を押すと、拡張機能ファイルの取得が始まります。"
      : "お名前の入力と同意のチェックで押せるようになります。";
  }

  let fullText = "", mailSubject = "", mailBody = "", fileName = "";

  function build() {
    const now = new Date();
    const fp = fingerprint(normalize(termsEl.innerText) + "|consent v" + VERSION + "|" + CONTRACT);
    const name = nameEl.value.trim();
    const when = stamp(now);
    fileName = "consent-" + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
      "-" + name.replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 20) + ".txt";

    mailSubject = "【video-shorts 同意】" + name + " " + when.slice(0, 10);
    mailBody =
      "video-shorts 外部サービス・AI利用 同意の通知\n" +
      "------------------------------\n" +
      "同意者      : " + name + "\n" +
      "同意日時    : " + when + "（送信者端末のローカル時刻）\n" +
      "同意書の版  : v" + VERSION + "（" + CONSENT_DATE + "）\n" +
      "準拠する契約: " + CONTRACT + "（別紙4・別紙5相当）\n" +
      "文言の指紋  : " + fp + "\n" +
      "------------------------------\n" +
      "上記のとおり、同意画面 v" + VERSION + " の内容すべて、及び AI顧問契約書（第10版）に同意しました。\n" +
      "このメールをもって署名に代えます。\n";

    fullText =
      "video-shorts 外部サービス・AI利用 同意の控え\n" +
      "==============================\n" +
      "同意者          : " + name + "\n" +
      "同意日時        : " + when + "（端末ローカル時刻）\n" +
      "同意書の版      : v" + VERSION + "（" + CONSENT_DATE + "）\n" +
      "準拠する契約    : " + CONTRACT + "（別紙4・別紙5相当）\n" +
      "文言の指紋      : " + fp + "\n" +
      "送信先          : " + CONTACT + "\n" +
      "取得ファイル    : " + PRODUCT + "\n" +
      "ブラウザ        : " + navigator.userAgent + "\n" +
      "==============================\n" +
      "【同意した文言 全文】\n" + termsEl.innerText.trim() + "\n" +
      "==============================\n" +
      "本同意書と AI顧問契約書 に齟齬があるときは顧問契約書が優先します。\n";
  }

  // 製品ファイルを実際にダウンロードする（Next の主動作）
  function downloadProduct() {
    const a = document.createElement("a");
    a.href = PRODUCT; a.download = PRODUCT;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  function openMail() {
    window.location.href = "mailto:" + encodeURIComponent(CONTACT) +
      "?subject=" + encodeURIComponent(mailSubject) + "&body=" + encodeURIComponent(mailBody);
    if (mailnoteEl) mailnoteEl.hidden = false;
  }
  function downloadText() {
    const blob = new Blob([fullText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  startEl.addEventListener("click", function () {
    if (startEl.disabled) return;
    build();
    receiptText.textContent = fullText;
    receiptEl.hidden = false;
    downloadProduct(); // ← Next の主動作：製品ファイルを取得
    nameEl.disabled = true;
    agreeEl.disabled = true;
    startEl.disabled = true;
    startEl.textContent = "ダウンロードを開始しました";
    receiptEl.scrollIntoView({ behavior: "smooth", block: "start" });
    // AUD-S-01: 同意完了後、フォーカスは押した#startのまま(disabled化で見た目上も
    // 宙に浮く)残っていた。控え(#receipt)へフォーカスを移し、完了をスクリーンリーダーが
    // 確実に読み上げられるようにする(role/aria-liveは静的markup側で既に用意済み)。
    // downloadProduct()が作る一時<a>のクリックで一瞬フォーカスが移ることがあるため、
    // ここで最後に呼んで確実に勝たせる。
    receiptEl.focus();
  });

  sendmailEl.addEventListener("click", function () { if (fullText) openMail(); });
  downloadEl.addEventListener("click", function () { if (fullText) downloadText(); });
  nameEl.addEventListener("input", refresh);
  agreeEl.addEventListener("change", refresh);
  refresh();
})();
