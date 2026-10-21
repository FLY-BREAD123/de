'use strict';
// ⚙️ 설정 — Render 대시보드 환경변수(또는 로컬 .env)에서 읽음

const fs = require('fs');
const path = require('path');

// 로컬 실행용 .env 로더 (Render에선 대시보드 환경변수를 씀)
(function loadDotEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  try {
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(file);
      return;
    }
  } catch { /* 아래 수동 파서로 */ }
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
})();

const env = (key, def = '') => String(process.env[key] ?? def).trim();
const bool = (key, def) => {
  const v = env(key).toLowerCase();
  if (!v) return def;
  return ['1', 'true', 'yes', 'on', 'y'].includes(v);
};

// ───────── 토큰 찾기 ─────────
// 환경변수 이름 오타(BOT_TOKEN, TOKEN, 이름에 공백·보이지 않는 글자)도 찾아서 쓰고, 진단에 어떤 이름을 썼는지 남김
const TOKEN_KEYS = ['DISCORD_TOKEN', 'DISCORD_BOT_TOKEN', 'BOT_TOKEN', 'TOKEN'];
const INV_CHARS = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map((c) => String.fromCharCode(c)).join('');
const INVISIBLE = new RegExp(`[${INV_CHARS}]`, 'g');
const HAS_INVISIBLE = new RegExp(`[${INV_CHARS}]`);
const normKey = (k) => k.replace(INVISIBLE, '').replace(/\s+/g, '').replace(/-/g, '_').toUpperCase();

function findToken() {
  const direct = process.env.DISCORD_TOKEN;
  if (direct && direct.trim()) return { key: 'DISCORD_TOKEN', raw: direct };
  for (const k of TOKEN_KEYS.slice(1)) {
    if (process.env[k] && process.env[k].trim()) return { key: k, raw: process.env[k] };
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (v && v.trim() && TOKEN_KEYS.includes(normKey(k))) return { key: k, raw: v };
  }
  return { key: '', raw: '' };
}

// 붙여넣기 실수(따옴표, "Bot " 접두사, 공백, 보이지 않는 글자) 자동 정리 + 뭘 고쳤는지 기록
function cleanToken(raw) {
  const issues = [];
  let t = String(raw || '');
  if (HAS_INVISIBLE.test(t)) issues.push('보이지 않는 글자');
  t = t.replace(INVISIBLE, '');
  if (t !== t.trim()) issues.push('앞뒤 공백');
  t = t.trim();
  if (/^["'`]|["'`]$/.test(t)) issues.push('따옴표');
  t = t.replace(/^["'`]+|["'`]+$/g, '');
  if (/^Bot\s+/i.test(t)) issues.push('"Bot " 접두사');
  t = t.replace(/^Bot\s+/i, '');
  if (/\s/.test(t)) issues.push('중간 공백·줄바꿈');
  t = t.replace(/\s+/g, '');
  return { token: t, issues };
}

const found = findToken();
const cleaned = cleanToken(found.raw);
const TOKEN = cleaned.token;

module.exports = {
  TOKEN,
  TOKEN_KEY: found.key, // 실제로 토큰을 읽은 환경변수 이름
  TOKEN_ISSUES: cleaned.issues, // 자동으로 고친 붙여넣기 실수
  // 테스트용 (평소엔 비워둠): 디스코드 API·게이트웨이 주소 바꾸기
  DISCORD_API: (env('FW_DISCORD_API') || 'https://discord.com/api').replace(/\/+$/, ''),
  LOGIN_TIMEOUT_MS: Number(env('FW_LOGIN_TIMEOUT_MS')) || 90 * 1000, // 이 시간 안에 접속 못 하면 멈춘 단계 진단 후 재시도
  DIAG_PUBLIC: bool('DIAG_PUBLIC', true), // /diag 진단 페이지 공개 여부
  PORT: Number(env('PORT', '3000')) || 3000,
  // Render가 자동으로 넣어주는 공개 주소 → 셀프핑으로 잠들기 방지
  PUBLIC_URL: (env('KEEPALIVE_URL') || env('RENDER_EXTERNAL_URL')).replace(/\/+$/, ''),
  ON_RENDER: env('RENDER') === 'true',

  ALERT_CHANNEL_ID: env('ALERT_CHANNEL_ID'),
  ALERT_ROLE_ID: env('ALERT_ROLE_ID'),
  DATA_CHANNEL_ID: env('DATA_CHANNEL_ID'),
  DATA_CHANNEL_NAME: env('DATA_CHANNEL_NAME', 'fifa-war-db'),

  BOARD_PUBLIC: bool('BOARD_PUBLIC', true), // 웹 순위표 공개 여부
  TEXT_COMMANDS: bool('TEXT_COMMANDS', true), // "@상대 피파전쟁" 텍스트 명령 (MESSAGE CONTENT INTENT 필요)

  TZ: 'Asia/Seoul',

  TIMING: {
    challengeMs: 5 * 60 * 1000, // 선포 후 응답 대기
    matchMs: 3 * 60 * 60 * 1000, // 수락 후 결과 입력 마감
    confirmMs: 10 * 60 * 1000, // 결과 제출 후 상대 확인 대기 → 지나면 자동 확정
    disputeGraceMs: 30 * 60 * 1000, // 이의제기 후 최소 재입력 시간
    cooldownMs: 20 * 1000, // 선포 도배 방지
    saveDebounceMs: 3000,
    keepAliveMs: 10 * 60 * 1000, // 15분 무트래픽이면 Render가 재움 → 10분마다 핑
  },

  COLORS: {
    alert: 0xff4d6d,
    accent: 0xb478ff,
    cyan: 0x4de8ff,
    win: 0x3ddc97,
    draw: 0x9a94a8,
    gray: 0x4a4458,
    gold: 0xffc94d,
  },
};
