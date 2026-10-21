'use strict';
// 🖨️ Render 로그용 진단표 출력

const ICON = { ok: '✅', warn: '⚠️ ', fail: '❌', info: 'ℹ️ ', wait: '⏳', skip: '⏭️ ' };

function print(report, title, { publicUrl = '' } = {}) {
  const L = [];
  L.push(`┌──────── ${title} ────────`);
  for (const g of report.groups) {
    if (!g.checks.length) continue;
    L.push(`│ [${g.label}]`);
    for (const c of g.checks) {
      L.push(`│  ${ICON[c.status] || '•'} ${c.title}${c.count > 1 ? ` (x${c.count})` : ''}`);
      if (c.status !== 'ok' && c.detail) L.push(`│      ${c.detail}`);
      if (c.status === 'fail' || c.status === 'warn') for (const f of c.fix || []) L.push(`│      → ${f}`);
    }
  }
  if (report.timeline?.length) {
    L.push('│ [접속 과정]');
    for (const e of report.timeline.slice(-12)) L.push(`│  +${(e.at / 1000).toFixed(1).padStart(5)}s  ${e.label}${e.count > 1 ? ` (x${e.count})` : ''}`);
  }
  L.push('└────────────────────────────────');
  const h = report.headline;
  if (h) {
    L.push(`👉 핵심 문제: ${h.title}`);
    (h.fix || []).forEach((f, i) => L.push(`   ${i + 1}. ${f}`));
  } else {
    L.push('👉 문제 없음');
  }
  if (publicUrl) L.push(`   자세히 보기: ${publicUrl}/diag`);
  for (const line of L) console.log(`[진단] ${line}`);
}

module.exports = { print };
