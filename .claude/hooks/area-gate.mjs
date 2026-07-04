#!/usr/bin/env node
  // PreToolUse:Write|Edit — 運用エリア統合ゲート

  import fs from 'node:fs';

  // research-bank bypass マーカー TTL（秒）。既存 .allow-destructive と同形
  const RB_MARKER_TTL_SEC = 600;

  const AREAS = [
    {
      name: 'plans',
      pathPattern: /[/\\]docs[/\\]ops[/\\]plans[/\\]/,
      validate: () => null,
    },
    {
      name: 'research-bank',
      pathPattern: /[/\\]docs[/\\]research-bank[/\\]/,
      validate: (toolName, input) => {
        const fp = (input.file_path || '').replace(/\\/g, '/');
        if (fp.endsWith('/index.html')) return null;
        if (fp.endsWith('.gitkeep')) return null;
        // /deep-research bypass: research-bank 直下の TTL マーカーが新鮮なら許可
        const idx = fp.indexOf('/docs/research-bank/');
        if (idx !== -1) {
          const marker = fp.slice(0, idx) + '/docs/research-bank/.allow-research-write';
          try {
            if (fs.existsSync(marker) && (Date.now() - fs.statSync(marker).mtimeMs) / 1000 < RB_MARKER_TTL_SEC) return null;
          } catch { /* マーカー判定失敗時は block にフォールバック */ }
        }
        return 'research-bank への手動書込は禁止です。/deep-research スキル経由で保存してください。詳細: docs/ops/research-bank-sop.md';
      },
    },
  ];

  let data = '';
  process.stdin.on('data', c => (data += c));
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(data);
      const fp = ((input.tool_input || {}).file_path || '').replace(/\\/g, '/');
      if (!fp) process.exit(0);

      for (const area of AREAS) {
        if (area.pathPattern.test(fp)) {
          const err = area.validate(input.tool_name || '', input.tool_input || {});
          if (err) {
            console.log(JSON.stringify({ decision: 'block', reason: '[' + area.name + '-gate] ' + err }));
          }
          process.exit(0);
        }
      }

      const m = fp.match(/\/docs\/ops\/([^/]+)\//);
      if (m && !fp.endsWith('.gitkeep')) {
        console.log(JSON.stringify({ decision: 'block', reason: '[未登録エリア] docs/ops/' + m[1] + '/ は area-gate.mjs に未登録です。' }));
        process.exit(0);
      }

      process.exit(0);
    } catch (e) {
      // 機能停止隠蔽防止: 異常時は stderr に記録 (hook-runner pass-through で見えなくなる罠を回避)
      process.stderr.write('[area-gate] error: ' + (e && e.message ? e.message : String(e)) + '\n');
      process.exit(0);
    }
  });
  