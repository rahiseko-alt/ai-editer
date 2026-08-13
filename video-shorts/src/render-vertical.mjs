// video-shorts [5] FFmpeg縦化＋字幕焼き — 区間を切り出し 9:16 中央crop→scale→字幕焼き。
// 落とし穴#2(字幕焼きは再エンコード・音声は -c:a copy 不可なので別扱い)
// 落とし穴#3(中央拡大は crop 先 → scale 後)。
//
// 注意: 字幕(subtitles filter)を使うと映像は必ず再エンコードされる。音声は変換不要なので
//       -c:a copy で無劣化コピーする（落とし穴#2の正しい解釈）。

import { spawn } from "node:child_process";
import path from "node:path";

import { buildTrimFilters, normalizeFpsRational } from "./trim-plan.mjs";

// 向き別の出力解像度。portrait=縦型(SNSリール等)、landscape=横型(画面録画・細かい文字を残す)。
const ORIENT = { portrait: [1080, 1920], landscape: [1920, 1080] };
const DEFAULT_ORIENT = "portrait";

/**
 * 拡大ガード込みの実際の出力canvas(W,H)を算出する。
 * 素材(srcW,srcH)が既定ターゲットより小さい場合、無理に拡大しないターゲットへ縮小する
 * （432x766素材を1080x1920へ6.2倍拡大しても画質向上ゼロで負荷だけ増える＝実測差分あり）。
 * k = min(TARGET_W/srcW, TARGET_H/srcH)。k>1（=そのままだと拡大）なら
 * even(TARGET_W/k) x even(TARGET_H/k) へ縮小（h264は偶数幅高さが必須）。
 * env FORCE_TARGET_RES=1 でガード無効化（オプトアウト）。
 * @returns {{w:number, h:number, guarded:boolean}}
 */
export function computeCanvas(orientation, srcW, srcH) {
  const [TARGET_W, TARGET_H] = ORIENT[orientation] || ORIENT[DEFAULT_ORIENT];
  const forceTarget = process.env.FORCE_TARGET_RES === "1";
  if (!forceTarget && srcW && srcH && srcW > 0 && srcH > 0) {
    const k = Math.min(TARGET_W / srcW, TARGET_H / srcH);
    if (k > 1) {
      const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
      return { w: even(TARGET_W / k), h: even(TARGET_H / k), guarded: true };
    }
  }
  return { w: TARGET_W, h: TARGET_H, guarded: false };
}

/**
 * 入力動画(16:9想定)から区間を切り出し、9:16縦型に中央crop→scaleし、ASS字幕を焼く。
 * crop先→scale後（落とし穴#3）。映像は再エンコード・音声は -c:a copy（落とし穴#2）。
 *
 * @param {object} p
 * @param {string} p.input 入力mp4
 * @param {number} p.start 開始秒
 * @param {number} p.end 終了秒
 * @param {string} p.assPath 焼き込む .ass 字幕パス（無ければ字幕なし）
 * @param {string} p.output 出力mp4
 * @param {number} [p.srcW] 素材の実横幅（拡大ガード用。省略時はガード無効）
 * @param {number} [p.srcH] 素材の実縦幅（拡大ガード用。省略時はガード無効）
 * @param {{start:number,end:number}[]} [p.keep] 残す区間（区間先頭を0とした相対秒）。
 *   渡すと、その区間だけを取り出してつなぐ（無音・言い淀みを詰める）。
 *   省略すると従来どおり、切り出した区間をそのまま焼く。
 * @param {number} [p.sampleRate] 素材の音声の標本化周波数。詰めるときに atrim を標本の番号で
 *   切るのに使う。省略するとここで実測する（取れなければ式の中で 48000 へ揃える）。
 * @param {string} [p.fpsRational] 素材のコマ数/秒（probeSize が返す r_frame_rate の分数文字列）。
 *   詰めるときに、コマ数/秒が一定でない素材（画面録画で出る）で絵が先に進むのを防ぐのに要る。
 *   省略すると従来どおり（コマ数/秒が一定の素材では結果は変わらない）。
 * @returns {Promise<{cmd:string, output:string}>}
 */
export async function renderClip(p) {
  const dur = Math.max(0.1, p.end - p.start);
  const canvas = computeCanvas(p.orientation, p.srcW, p.srcH);
  const TARGET_W = canvas.w;
  const TARGET_H = canvas.h;
  if (canvas.guarded) {
    process.stderr.write(
      `[INFO] 拡大ガード: 素材${p.srcW}x${p.srcH} → 出力${TARGET_W}x${TARGET_H}（拡大なし）\n`
    );
  }
  const assFilter = p.assPath
    ? `,ass='${escapeFilterPath(p.assPath)}'`
    : "";
  // 素材そのまま方式: 拡大ぼかし帯のような余分な処理はしない。
  // 元映像をアスペクト比維持で TARGET へ収め(decrease)、余白は黒帯(pad)で埋めるだけ。
  //  - portrait(1080x1920): 顔出しトーク向け。16:9素材は中央に縮小され上下に黒帯。
  //  - landscape(1920x1080): 画面録画向け。16:9素材はほぼ原寸で文字が読める。
  // boxblur=40 をフル解像度に毎フレーム掛けるのを廃止し再エンコード負荷を激減
  //（実測: 20秒あたり約48s → 約7s の約7倍速）。
  //
  // === A/V 同期（入力シーク1段方式）===
  //  - `-ss <start>` を `-i` の前に1つだけ置く。ffmpeg 2.1+ の入力シークはキーフレームへ飛んだ後
  //    目的位置までデコードして捨てるため、これ単独でフレーム精度が出る（粗＋精の2段は不要）。
  //  - `-t <dur>` で出力長を指定。切り出しは filter(trim/atrim) ではなくシークで行うため
  //    映像/音声は同一の入力タイムライン上で同時に切られ、開始点が食い違わない。
  //  - `-avoid_negative_ts` は付けない（make_zero は映像側にのみ +21ms の edit-list 起点を残し
  //    映像 start_time≈0.021 / 音声 0.000 の一定オフセットを生む主因）。
  //  - `-bf 0`: B フレーム reorder 由来の mp4 edit-list 先頭オフセットを排除（映像 start_time を 0 に）。
  //  - `setpts=PTS-STARTPTS`: 映像の先頭フレーム PTS を 0 に正規化する（個体差で残る 1 フレーム
  //    ≈33ms のずれを潰す）。
  // 旧 trim/atrim 方式は映像 start_time≈0.021 / 音声 0.000 の 21ms 残留があった。
  // 入力シーク1段へ移行後も start_time は 0.000/0.000 を維持する（2026-07-23 に本方式で再実測。
  // lecture.mp4 の start=0 / 300 / 700s の 3 クリップとも video・audio 共に 0.000000・duration 一致）。
  // ＝下の -bf 0 / -avoid_negative_ts を付けない / setpts の 3 点は 1 段化後も引き続き必要。
  //
  // === 2段シーク（粗 -ss coarse + 精 -ss fine）を廃した理由（2026-07-23 実測で根治）===
  // 出力シーク（`-i` の後の `-ss`）は **filtergraph より後段** で適用される。showinfo で実測すると
  // フィルタに流れる先頭フレームは pts_time=0（＝coarse 起点）で、精シーク分は捨てられていない。
  // 一方 ASS 本体は wordsInRange() が「区間先頭 = p.start」を 0 とした相対時刻で書いている
  // （srt-builder.mjs）。よって ass フィルタは coarse 起点の 0 から字幕を焼き、その結果を後段の
  // 出力シークが fine 秒ぶん切り落とすため、**字幕が常に PREROLL 秒ぶん先行**していた。
  // 実測（lecture.mp4 の 300-312s 区間）: 出力 t=0.5s に ASS の 2.26-2.56s 行が焼かれていた。
  // setpts と ass の順序を入れ替えても解消しない（フィルタ入力 PTS が既に 0 のため setpts が no-op）。
  // 入力シーク1段にすると filtergraph の 0 = p.start となり ASS の相対時刻と一致する。
  // 無音・言い淀みを詰める場合は、先に残す区間だけを取り出してつなぎ、
  // そのあとで縦化と字幕焼きを掛ける。順序が逆だと、切って捨てる部分にも
  // 縦化と字幕焼きの費用を払うことになるうえ、字幕の時刻が詰める前のままになる。
  // 字幕(ASS)の時刻は、呼び出し側が詰めたあとの時間軸へ写してから渡すこと
  // （srt-builder に渡す words を trim-plan の remapWords に通す）。
  // 音声の標本化周波数は、詰めるときだけ要る（atrim を標本の番号で切るため）。
  // 呼び出し側が渡さなければここで実測する。取れなければ buildTrimFilters が
  // 既定値へ落ちるが、式の中で aresample を掛けてその周波数へ揃えるので、
  // 切る位置の秒はどちらでも狙いどおりになる。
  const trimNeeded = !!(p.keep && p.keep.length);
  // keep（詰め）を使う経路だけ、音声標本化周波数と音声トラックの有無を実測する。
  // trim を使わない経路は `-map 0:a?` が既に音声無し素材へ安全に対応済みなので不要（性能配慮）。
  const [sampleRate, hasAudio] = trimNeeded
    ? await Promise.all([
      Number.isFinite(p.sampleRate) && p.sampleRate > 0
        ? Promise.resolve(p.sampleRate)
        : probeSampleRate(p.input).catch(() => null),
      // probe自体が失敗した場合は「音声ありうる」という従来どおりの前提を維持する
      // （失敗を「音声無し」と誤判定して音声を消してしまうより安全）。
      probeHasAudio(p.input).catch(() => true),
    ])
    : [null, true];
  const trim = trimNeeded
    ? buildTrimFilters(p.keep, { fpsRational: p.fpsRational, sampleRate, hasAudio })
    : null;
  const videoIn = trim ? "[tvout]" : "[0:v]";

  // === HDR→SDR変換 + 出力を8bit yuv420p BT.709へ強制（AUD-P1-09） ===
  // 一般的なスマホ・SNSの再生環境は 10bit/BT.2020(HDR) 入力をそのまま渡すと拒否・色化けする。
  // PQ(smpte2084)/HLG(arib-std-b67)伝達関数、またはBT.2020原色の素材だけ zscale+tonemap で
  // SDR/BT.709へ変換してから8bit 4:2:0へ落とす。既にSDRの素材にtonemapを掛けると
  // 不要な色変化を招くため、そちらは pix_fmt を yuv420p へ強制するだけに留める。
  const colorInfo = await probeColorInfo(p.input).catch(() => null);
  const hdr = isHdrColorInfo(colorInfo);
  const colorChain = hdr
    ? "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
      + "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,"
    : "format=yuv420p,";

  // === SAR/DAR正規化（AUD-P2-21） ===
  // 素材のサンプルアスペクト比(SAR)が 1:1 でない（コーデック側の非正方形ピクセル）場合、
  // coded width/height をそのまま fit すると実際の表示アスペクト比と異なる比率で押し込まれ、
  // 横につぶれる/伸びる。scale フィルタが公開する `sar`（入力の実SAR）で物理的に正方形ピクセル
  // へ伸縮してから setsar=1 で「もう正方形」と宣言し、そのあとで初めて TARGET へ fit/pad する。
  // SAR=1:1（大半の素材）では trunc(iw*1/2)*2 は iw のままなので実質恒等。
  const sarChain = "scale=trunc(iw*sar/2)*2:ih,setsar=1,";

  const scaleChain =
    `${videoIn}${sarChain}${colorChain}scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease,` +
    `pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,` +
    `setpts=PTS-STARTPTS` + assFilter + `[v]`;
  // 詰める式は映像と音声を1本の concat で繋ぐ（区間ごとの端数を継ぎ目で清算させるため）。
  // 映像用・音声用に2本へ分けると、差が継ぎ目の数だけ積み上がる（src/trim-plan.mjs の注を参照）。
  const vf = trim ? `${trim.chain};${scaleChain}` : scaleChain;

  const args = [
    "-y",
    "-ss", String(p.start), // 入力シーク（-i の前・1段。filtergraph の 0 が p.start と一致する）
    "-i", p.input,
    "-t", String(dur),
    "-filter_complex", vf,
    "-map", "[v]",
    // 詰める場合は詰めた音声を（音声トラックが無い素材では [taout] 自体を作らない＝AUD-S-02）、
    // 詰めない場合はシークで切り出し済みの音声をそのまま map（無音素材でも落ちないよう ?）。
    ...(trim ? (trim.hasAudio ? ["-map", "[taout]"] : []) : ["-map", "0:a?"]),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    // HDR→SDR変換の有無に関わらず、出力は必ず8bit 4:2:0 + BT.709で書く（AUD-P1-09）。
    // フィルタ側(colorChain)で既に yuv420p 化しているが、コンテナのタグ付けも明示して二重に保証する。
    "-pix_fmt", "yuv420p",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
    "-colorspace", "bt709",
    // 出力を等間隔のコマ列で書く。concat は区間ごとに「一番長いストリームの長さ」で次へ進むので、
    // 音声が映像より 1 標本だけ長い区間があると、次の区間の映像がコマ格子から 1 標本ぶん外れる。
    // cfr にしておくと、その 1 コマ未満の穴が複製で埋まり、絵と音の対応がずれない。
    "-fps_mode", "cfr",
    "-bf", "0", // B フレーム無効化＝reorder 遅延の edit-list 先頭オフセットを排除し映像 start_time を 0 に
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    p.output,
  ];
  return runFfmpeg(args);
}

/**
 * パスを ass フィルタのオプション値用にエスケープする。呼出側で単一引用符ラップ
 * （ass='...'）する前提。
 *
 * ffmpeg はフィルタのオプション値を **2 段階** で解釈するため、エスケープも 2 段必要になる。
 *  - 第1段: filtergraph の解析（`,` `;` `[` `]` でフィルタを切り出す。`'` で引用、`\` で escape）
 *  - 第2段: フィルタ自身のオプション解析（`:` でオプション、`=` で key=value を切る。
 *           ここでも `'` と `\` が特殊文字として再度処理される）
 * 第1段の単一引用符は「そのフィルタの引数の切り出し」までしか守らない。引用符は第1段で
 * 取り除かれるので、第2段には裸の文字列が渡る。よって第2段の特殊文字（`\` `'` `:` `=`）は
 * バックスラッシュで明示的に escape してから、第1段用に引用符でくくる必要がある。
 *
 * 実測（ffmpeg 6.1.1）: 旧実装は `:` だけを escape していたためコロンは通っていたが、
 * `'` を含むパスは第2段で引用符の開始と誤認されて "Error initializing filters" で落ちていた。
 *
 * なお `\` → `/` の置換は Windows のパス区切りを filtergraph 向けに正規化するためのもので、
 * Windows でのみ行う。POSIX では `\` はファイル名の正当な 1 文字であり、置換すると
 * 別のパスに化けて字幕が見つからなくなる（旧実装は全プラットフォームで置換していた）。
 */
function escapeFilterPath(p) {
  const normalized = process.platform === "win32" ? p.replace(/\\/g, "/") : p;
  // 第2段（フィルタのオプション解析）用: \ ' : = をバックスラッシュで escape
  const forOptionParser = normalized.replace(/[\\':=]/g, (c) => `\\${c}`);
  // 第1段（filtergraph 解析）用: 呼出側の単一引用符の内側では ' だけが特殊。'\'' で閉じ直す。
  return forOptionParser.replace(/'/g, "'\\''");
}

/** ffmpeg を起動し stderr を拾って解決/却下する */
export function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg ${args.join(" ")}`;
    const proc = spawn("ffmpeg", args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", (e) => reject(new Error(`ffmpeg 起動失敗: ${e.message}`)));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ cmd, output: args[args.length - 1] });
      } else {
        reject(new Error(`ffmpeg 終了コード ${code}\n${stderr.slice(-1200)}`));
      }
    });
  });
}

/**
 * "32:27" のような比率文字列を {num,den} へ。未設定（"0:1" 等）・解釈不能なら
 * 正方形ピクセル 1:1 を返す（ffprobe の sample_aspect_ratio は SAR 不明のとき "0:1" を返す）。
 */
function parseSar(raw) {
  if (typeof raw === "string") {
    const m = raw.trim().match(/^(\d+)\s*:\s*(\d+)$/);
    if (m) {
      const num = Number(m[1]);
      const den = Number(m[2]);
      if (num > 0 && den > 0) return { num, den };
    }
  }
  return { num: 1, den: 1 };
}

/**
 * ffprobe で width,height を取得（縦型検証用）。SAR/DAR正規化（AUD-P2-21）も併せて行う。
 *
 * 【なぜ csv ではなく json で読むか】ffprobe の csv 出力は `-show_entries` に指定した順序を
 * 守らず、ffprobe 内部の正準フィールド順（width, height, sample_aspect_ratio, r_frame_rate,
 * avg_frame_rate, ...）で並べ替えて返す（実測で確認済み）。位置でパースすると、
 * 要求に無いフィールドが割り込む/要求順を変えるだけで無警告に列がずれる。json なら
 * フィールド名で読むので、この並べ替えの影響を受けない。
 *
 * 【SAR/DAR正規化】コーデック側で非正方形ピクセル（SAR≠1:1）を使う素材は、coded な
 * width/height だけを見ると実際の表示アスペクト比と異なる。sample_aspect_ratio を読み、
 * 表示上の幅 = width * (SARnum/SARden) を displayWidth として返す。呼び出し側
 * （computeCanvas の拡大ガード・fitの目標選び）は coded ではなくこちらを使うべき値。
 * ※ フィルタグラフ自体の物理的な伸縮（実際に映像を歪みなく直す部分）は render-vertical.mjs
 *   の renderClip 内で ffmpeg の `sar` 変数を使って行う（ここでの数値はJS側の判断材料用）。
 */
export function probeSize(file) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error",
      "-select_streams", "v:0",
      // コマ数/秒も取る。詰めるときに区間の端をコマ境界へ揃えるのに要る
      // （揃えないと映像と音声で切れ方が違い、継ぎ目の数だけずれが積み上がる）。
      // r_frame_rate が 0/0 になる素材があるので avg_frame_rate も併せて取り、二段構えにする。
      "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate,sample_aspect_ratio",
      "-of", "json",
      file,
    ];
    const proc = spawn("ffprobe", args, { windowsHide: true });
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("error", (e) => reject(e));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe code ${code}`));
      let stream;
      try {
        stream = JSON.parse(out).streams?.[0] ?? {};
      } catch (e) {
        return reject(new Error(`ffprobe(probeSize) json 解析失敗: ${e.message}`));
      }
      const w = Number(stream.width);
      const h = Number(stream.height);
      const rateRaw = stream.r_frame_rate;
      const avgRaw = stream.avg_frame_rate;
      // r_frame_rate が取れなければ avg_frame_rate を使う。どちらも駄目なら null。
      const fps = parseFrameRate(rateRaw) ?? parseFrameRate(avgRaw);
      // 分数のままの姿も返す。詰めるときに ffmpeg の fps フィルタへ渡すのに要る。
      // Number 化した fps を渡すと 30000/1001 が 29.97 に丸まり、約1万秒に1コマずれる。
      // fps と同じ側（r_frame_rate 優先）から取り、食い違わないようにする。
      const fpsRational = parseFrameRate(rateRaw) !== null
        ? normalizeFpsRational(rateRaw)
        : normalizeFpsRational(avgRaw);
      const sar = parseSar(stream.sample_aspect_ratio);
      const displayWidth = Number.isFinite(w) && w > 0
        ? Math.max(1, Math.round((w * sar.num) / sar.den))
        : w;
      resolve({
        width: w, height: h, vertical: h > w, fps, fpsRational,
        sarNum: sar.num, sarDen: sar.den, displayWidth, displayHeight: h,
      });
    });
  });
}

/**
 * ffprobe で音声の標本化周波数を取る（詰めるときに atrim を標本の番号で切るのに要る）。
 *
 * 音声が無い素材・読めない素材では null を返す。呼び出し側は既定値へ落ちるが、
 * フィルタ式の側で aresample を掛けて実際にその周波数へ揃えるので、
 * 切る位置の秒は取れても取れなくても狙いどおりになる（音が入り直すだけ）。
 */
export function probeSampleRate(file) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error", "-select_streams", "a:0",
      "-show_entries", "stream=sample_rate", "-of", "csv=p=0", file,
    ];
    const proc = spawn("ffprobe", args, { windowsHide: true });
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("error", (e) => reject(e));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe code ${code}`));
      const sr = Number(out.trim().split(/[\s,]+/)[0]);
      resolve(Number.isFinite(sr) && sr > 0 ? sr : null);
    });
  });
}

/**
 * ffprobe で音声ストリームが1本でも在るかを調べる（AUD-S-02）。
 *
 * `-select_streams a` に一致するストリームが無いと、ffprobe は exit code 0・stdout 空で
 * 終わる（src/av-verify.mjs の P2-2 の知見と同じ）。よってこれを「そのまま数値化して
 * 0 と誤認する」のではなく、出力が空かどうかで有無を判定する。
 */
export function probeHasAudio(file) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error", "-select_streams", "a",
      "-show_entries", "stream=index", "-of", "csv=p=0", file,
    ];
    const proc = spawn("ffprobe", args, { windowsHide: true });
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("error", (e) => reject(e));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe code ${code}`));
      resolve(out.trim().length > 0);
    });
  });
}

/**
 * ffprobe で色情報（pix_fmt・原色・伝達関数・行列）を取得する（AUD-P1-09）。
 * HDR判定（isHdrColorInfo）の入力に使う。読めなければ呼び出し側は catch して null 扱いにする。
 */
export function probeColorInfo(file) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=pix_fmt,color_primaries,color_transfer,color_space",
      "-of", "json", file,
    ];
    const proc = spawn("ffprobe", args, { windowsHide: true });
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("error", (e) => reject(e));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe code ${code}`));
      let stream;
      try {
        stream = JSON.parse(out).streams?.[0] ?? {};
      } catch (e) {
        return reject(new Error(`ffprobe(probeColorInfo) json 解析失敗: ${e.message}`));
      }
      resolve({
        pixFmt: stream.pix_fmt ?? null,
        colorPrimaries: stream.color_primaries ?? null,
        colorTransfer: stream.color_transfer ?? null,
        colorSpace: stream.color_space ?? null,
      });
    });
  });
}

/**
 * color情報から HDR（PQ=smpte2084 / HLG=arib-std-b67 の伝達関数、または BT.2020 原色）と
 * 判定できるか。どちらとも取れない・不明な素材は false（＝SDRとして扱い、tonemapは掛けない
 * ＝不要な色変化を避ける）。
 */
export function isHdrColorInfo(info) {
  if (!info) return false;
  const transfer = String(info.colorTransfer || "").toLowerCase();
  const primaries = String(info.colorPrimaries || "").toLowerCase();
  return transfer.includes("2084") || transfer.includes("arib-std-b67") || transfer.includes("hlg")
    || primaries.includes("2020");
}

/**
 * ffprobe の r_frame_rate（"30000/1001" のような分数）を秒あたりのコマ数へ直す。
 *
 * r_frame_rate が "0/0" になる素材がある。そのまま割ると落ちるし、0 のまま使うと
 * コマ境界の計算が壊れる。取れなかったときは null を返し、呼び出し側は
 * 「コマ境界へ揃えない（従来どおりの動き）」にする。詰めないより、
 * 揃えずに詰めるほうが害が小さいため（src/apply_mosaic_cli.py の probe と同じ考え方）。
 */
export function parseFrameRate(raw) {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const den = Number(m[2]);
  if (den === 0) return null;
  const fps = Number(m[1]) / den;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

/** 出力ファイル名を作る（区間番号 + 短いhook） */
export function clipName(outDir, index, hook) {
  const safe = (hook || `clip`).replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 16) || "clip";
  return path.join(outDir, `short-${String(index + 1).padStart(2, "0")}-${safe}.mp4`);
}
