'use strict';
// 🧪 환경 검사 — Node 버전, 실행 위치(Render), 토큰 환경변수(이름·값·형식), 셀프핑

const { PORTAL } = require('../explain');

const NEW_TOKEN_STEPS = [
  `Developer Portal(${PORTAL}) → 내 봇 → Bot 탭 → Reset Token → Copy`,
  'Render → 서비스 → Environment → Add Environment Variable',
  'Key 칸에 DISCORD_TOKEN 직접 타이핑 (복사·붙여넣기 하면 보이지 않는 글자가 섞일 수 있어요)',
  'Value 칸에 토큰만 붙여넣기 (따옴표·공백 없이) → Save Changes → 자동 재시작',
];

/** 토큰 첫 부분 = 봇 ID 를 base64 로 바꾼 것 → 어떤 봇 토큰인지 알 수 있음 (비밀 아님) */
function botIdFromToken(token) {
  try {
    const s = Buffer.from(String(token).split('.')[0], 'base64').toString('utf8');
    return /^\d{15,22}$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

function run(cfg) {
  const out = [];
  const add = (id, status, title, extra = {}) => out.push({ id, group: 'env', status, title, ...extra });

  // Node
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) add('env.node', 'ok', `Node.js ${process.versions.node}`);
  else {
    add('env.node', 'fail', `Node.js 버전이 너무 낮아요 (${process.versions.node}) — discord.js 14 는 18 이상 필요`, {
      fix: ['package.json 의 "engines": { "node": "22.x" } 가 깃허브에 올라가 있는지 확인', 'Render → Environment 에 NODE_VERSION = 22 추가'],
    });
  }

  // 실행 위치
  if (cfg.ON_RENDER) {
    const type = process.env.RENDER_SERVICE_TYPE || '';
    const name = process.env.RENDER_SERVICE_NAME || '';
    const label = { web: 'Web Service', worker: 'Background Worker', pserv: 'Private Service', cron: 'Cron Job' }[type] || type || '알 수 없음';
    add('env.host', 'ok', `Render ${label}${name ? ` · ${name}` : ''}`);
  } else {
    add('env.host', 'info', '내 컴퓨터(로컬)에서 실행 중');
  }

  // 토큰
  const others = Object.keys(process.env).filter((k) => k !== cfg.TOKEN_KEY && /token/i.test(k) && /discord|bot/i.test(k));
  if (!cfg.TOKEN) {
    add('env.token', 'fail', '봇 토큰 환경변수(DISCORD_TOKEN)가 없어요', {
      detail: others.length ? `비슷한 이름은 있어요: ${others.join(', ')} — 값이 비어 있는지 확인` : 'Render 에 DISCORD_TOKEN 이 등록 안 됐거나 값이 비어 있어요',
      fix: NEW_TOKEN_STEPS,
      fatal: true,
    });
    return out;
  }

  const t = cfg.TOKEN;
  let problem = '';
  if (/[^\x21-\x7e]/.test(t)) problem = '토큰에 한글이나 이상한 글자가 섞여 있어요 (예시 문구를 그대로 넣은 건 아닌지 확인)';
  else if (/^\d{15,22}$/.test(t)) problem = '숫자만 있는 값은 토큰이 아니라 Application ID 예요';
  else if (!t.includes('.')) problem = '점(.)이 없는 값은 토큰이 아니라 Client Secret 이에요 (OAuth2 탭 값)';
  else if (t.split('.').length !== 3) problem = `토큰은 점(.)으로 나뉜 3조각이어야 하는데 ${t.split('.').length}조각이에요 — 일부만 복사됐어요`;
  else if (t.length < 50) problem = `토큰이 너무 짧아요 (${t.length}자) — 일부만 복사된 것 같아요`;

  const botId = botIdFromToken(t);
  if (!problem && !botId) problem = '토큰 첫 부분에 봇 ID가 안 들어 있어요 — 봇 토큰이 아닌 값이에요';

  if (problem) {
    add('env.token', 'fail', `DISCORD_TOKEN 값이 잘못됐어요 — ${problem}`, { fix: NEW_TOKEN_STEPS, fatal: true, data: { length: t.length } });
    return out;
  }

  const notes = [];
  if (cfg.TOKEN_KEY !== 'DISCORD_TOKEN') notes.push(`환경변수 이름이 "${cfg.TOKEN_KEY.trim()}"${cfg.TOKEN_KEY !== cfg.TOKEN_KEY.trim() ? ' (공백 섞임)' : ''} 이라서 그걸로 읽었어요`);
  if (cfg.TOKEN_ISSUES.length) notes.push(`붙여넣기 실수 자동으로 고침: ${cfg.TOKEN_ISSUES.join(', ')}`);
  add('env.token', notes.length ? 'warn' : 'ok', notes.length ? `토큰 설정 실수를 자동으로 고쳐서 읽었어요 · 봇 ID ${botId}` : `봇 토큰 형식 정상 · 이 토큰의 봇 ID ${botId}`, {
    detail: notes.join(' / ') || `토큰 길이 ${t.length}자 · 환경변수 ${cfg.TOKEN_KEY}`,
    fix: notes.length ? ['지금도 접속은 돼요. 깔끔하게 하려면 Key 를 DISCORD_TOKEN 으로, Value 에 토큰만 넣기'] : [],
    data: { botId },
  });

  // 셀프핑 (Render 무료 웹서비스는 15분 동안 접속 없으면 잠듦)
  if (cfg.ON_RENDER && (process.env.RENDER_SERVICE_TYPE || 'web') === 'web') {
    if (cfg.PUBLIC_URL) add('env.keepalive', 'ok', `잠들기 방지 셀프핑 켜짐 (10분마다 ${cfg.PUBLIC_URL}/health)`);
    else {
      add('env.keepalive', 'warn', '셀프핑 주소를 몰라서 15분 뒤 서버가 잠들 수 있어요', {
        fix: ['Render → Environment 에 KEEPALIVE_URL = https://(서비스이름).onrender.com 추가'],
      });
    }
  }
  return out;
}

module.exports = { run, botIdFromToken };
