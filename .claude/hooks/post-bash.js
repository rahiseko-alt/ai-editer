// PostToolUse:Bash — デプロイ後のソースコード照合（問題2対策）
const fs = require('fs');
const { execSync } = require('child_process');

let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(input);
    const cmd = (j.tool_input.command || '').trim();
    const stdout = (j.tool_response && j.tool_response.stdout) || '';
    const cwd = (j.cwd || '').replace(/\\/g, '/');

    // vercel --prod で始まるコマンドのみ対象（パイプ内の文字列一致を除外）
    if (!/^(npx\s+)?vercel\s+.*--prod/.test(cmd) && !/^cd\s+.*&&\s*(npx\s+)?vercel\s+.*--prod/.test(cmd)) {
      process.exit(0);
    }

    // "cd PATH && vercel" 形式の場合、cd 先をデプロイルートとして使用
    const cdMatch = cmd.match(/cd\s+"?([^"&]+)"?\s*&&/);
    const deployRoot = cdMatch ? cdMatch[1].trim().replace(/\\/g, '/') : cwd;

    // デプロイURLをvercel出力から抽出
    const urlMatch = stdout.match(/https:\/\/[a-zA-Z0-9._-]+\.[a-zA-Z]{2,}/g);
    const deployUrl = urlMatch ? urlMatch[urlMatch.length - 1] : null;

    if (!deployUrl) {
      console.log(JSON.stringify({
        decision: 'block',
        reason: '⚠️ デプロイ検証FAIL: vercel出力からデプロイURLを特定できませんでした。手動でURLを確認し、画面を検証してください。'
      }));
      process.exit(0);
    }

    // ソースHTMLを特定
    let source = null;
    const candidates = [
      deployRoot + '/public/index.html',
      deployRoot + '/index.html',
      deployRoot + '/app/public/index.html',
      deployRoot + '/creative-portfolio-portal.html',
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        source = c;
        break;
      }
    }

    // デプロイ先HTMLを取得（3秒待機後）
    execSync('sleep 3');
    let deployBody = '';
    let httpCode = '';
    try {
      deployBody = execSync(`curl -sL --max-time 10 "${deployUrl}"`, { encoding: 'utf8', shell: 'bash' });
      httpCode = execSync(`curl -sL -o /dev/null -w "%{http_code}" --max-time 10 "${deployUrl}"`, { encoding: 'utf8', shell: 'bash' }).trim();
    } catch(e) {
      httpCode = 'ERROR';
    }

    const errors = [];

    if (httpCode !== '200') {
      errors.push(`HTTP ${httpCode}（200以外）`);
    }
    if (!deployBody) {
      errors.push('レスポンスbodyが空');
    }

    // ソースHTMLが見つからない場合は警告
    if (!source) {
      errors.push('ソースHTML（index.html）が見つかりません。手動でデプロイ先の画面を確認してください');
    }

    // ソースHTMLとの照合
    if (source && deployBody) {
      const srcHtml = fs.readFileSync(source, 'utf8');

      // title照合
      const titleMatch = srcHtml.match(/<title>([^<]+)<\/title>/);
      if (titleMatch) {
        if (!deployBody.includes(titleMatch[0])) {
          errors.push(`titleタグ不一致: ソース=${titleMatch[0]} がデプロイ先に存在しない`);
        }
      }

      // id属性照合（最大5個）
      const idMatches = srcHtml.match(/id="[^"]+"/g) || [];
      for (const idAttr of idMatches.slice(0, 5)) {
        if (!deployBody.includes(idAttr)) {
          errors.push(`${idAttr} がデプロイ先に存在しない`);
        }
      }
    }

    if (errors.length > 0) {
      console.log(JSON.stringify({
        decision: 'block',
        reason: `⚠️ デプロイ検証FAIL (${deployUrl}):\n${errors.map(e => '  - ' + e).join('\n')}\nソースとデプロイ先の不一致を解消してください。`
      }));
    }
    // errors が空なら何も出力せず exit 0（ブロックしない）

  } catch(e) {
    // パースエラー等は無視
    process.exit(0);
  }
});
