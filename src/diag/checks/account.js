'use strict';
// 🤖 봇 계정 검사 (토큰 사용) — 토큰 유효성, 봇 이름, 인텐트 설정, Interactions URL,
//    초대 설정, 오늘 남은 접속 횟수, 들어가 있는 서버

const { PORTAL, RESET_TOKEN, MESSAGE_CONTENT } = require('../explain');
const { BAN_FIX, looksBanned } = require('./net');
const { GUILD_NEEDS, missing, worst } = require('../perms');

const UA = 'DiscordBot (https://github.com/discordjs/discord.js, 14) fifa-war-bot-diag';
const FLAG = {
  PRESENCE: (1 << 12) | (1 << 13),
  MEMBERS: (1 << 14) | (1 << 15),
  MESSAGE_CONTENT: (1 << 18) | (1 << 19),
};

function inviteUrl(appId) {
  return `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot%20applications.commands&permissions=248912`;
}

async function call(cfg, path) {
  const t = Date.now();
  try {
    const res = await fetch(`${cfg.DISCORD_API}/v10${path}`, {
      headers: { Authorization: `Bot ${cfg.TOKEN}`, 'User-Agent': UA },
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* HTML 등 */
    }
    return {
      status: res.status,
      ok: res.ok,
      json,
      text,
      ms: Date.now() - t,
      type: res.headers.get('content-type'),
      retry: Number(res.headers.get('retry-after')) || 0,
    };
  } catch (error) {
    return { status: 0, ok: false, error, ms: Date.now() - t };
  }
}

async function run(cfg, { botIdFromToken }) {
  const out = [];
  const add = (id, status, title, extra = {}) => out.push({ id, group: 'account', status, title, ...extra });
  const result = { tokenOk: false, banned: false, retryAfterSec: 0, contentIntent: null, app: null, me: null, guilds: null, sessions: null, netError: false };

  // 1) 토큰 확인
  const me = await call(cfg, '/users/@me');
  if (me.status === 0) {
    add('account.token', 'fail', `토큰 확인 요청이 실패했어요 (${me.error?.cause?.code || me.error?.name || me.error?.message})`, { fix: ['네트워크 문제 — 자동으로 다시 검사해요'] });
    result.netError = true;
    return { checks: out, result };
  }
  if (me.status === 401) {
    add('account.token', 'fail', '토큰이 틀렸거나 무효예요 (HTTP 401 Unauthorized)', {
      detail: `이 토큰에 적힌 봇 ID: ${botIdFromToken(cfg.TOKEN) || '알 수 없음'} — Developer Portal 의 APPLICATION ID 와 같은지 확인. 같은데도 401이면 토큰이 재발급(Reset)돼서 예전 토큰이 무효가 된 거예요`,
      fix: RESET_TOKEN,
      fatal: true,
    });
    return { checks: out, result };
  }
  if (looksBanned(me.status, me.type, me.text)) {
    result.banned = true;
    result.retryAfterSec = me.retry;
    add('account.token', 'fail', `디스코드가 이 서버의 IP를 차단했어요 (HTTP ${me.status})`, { fix: BAN_FIX });
    return { checks: out, result };
  }
  if (me.status === 429) {
    result.retryAfterSec = me.retry || 30;
    add('account.token', 'warn', `토큰 확인이 레이트리밋에 걸렸어요 (${result.retryAfterSec}초 대기)`, { fix: ['자동으로 다시 검사해요'] });
    return { checks: out, result };
  }
  if (!me.ok || !me.json?.id) {
    add('account.token', 'fail', `토큰 확인 실패 (HTTP ${me.status})`, { detail: (me.text || '').slice(0, 160), fix: ['자동으로 다시 검사해요'] });
    result.netError = true;
    return { checks: out, result };
  }
  result.tokenOk = true;
  result.me = me.json;
  const tag = me.json.discriminator && me.json.discriminator !== '0' ? `${me.json.username}#${me.json.discriminator}` : me.json.username;
  if (me.json.bot === false) {
    add('account.token', 'fail', '봇 토큰이 아니라 사람 계정 토큰이에요', { fix: RESET_TOKEN, fatal: true });
    return { checks: out, result };
  }
  add('account.token', 'ok', `토큰 인증 정상 → 봇 "${tag}" (ID ${me.json.id})`);

  // 2) 앱 설정 / 접속 한도 / 서버 목록 (동시에)
  const [app, gw, guilds] = await Promise.all([call(cfg, '/applications/@me'), call(cfg, '/gateway/bot'), call(cfg, '/users/@me/guilds?limit=200')]);

  if (app.ok && app.json) {
    const a = app.json;
    result.app = a;
    const flags = Number(a.flags) || 0;
    const content = (flags & FLAG.MESSAGE_CONTENT) !== 0;
    result.contentIntent = content;
    if (!cfg.TEXT_COMMANDS) add('account.intent', 'info', '텍스트 명령 꺼둠 (TEXT_COMMANDS=false) — 슬래시 명령만 사용');
    else if (content) add('account.intent', 'ok', 'MESSAGE CONTENT INTENT 켜짐 → "@친구 피파전쟁" 텍스트 명령 사용 가능');
    else {
      add('account.intent', 'warn', 'MESSAGE CONTENT INTENT 꺼짐 → "@친구 피파전쟁" 텍스트 명령은 안 되고 슬래시(/전쟁)만 돼요', {
        detail: '봇은 슬래시 명령 전용으로 정상 접속해요',
        fix: MESSAGE_CONTENT,
      });
    }
    const iurl = String(a.interactions_endpoint_url || '').trim();
    if (iurl) {
      add('account.interactions', 'fail', 'INTERACTIONS ENDPOINT URL 이 설정돼 있어서 슬래시 명령·버튼이 봇한테 안 와요', {
        detail: `지금 값: ${iurl} — 이게 있으면 디스코드가 명령을 그 주소로만 보내요 ("애플리케이션이 응답하지 않았어요" 오류)`,
        fix: [`Developer Portal(${PORTAL}) → 내 봇 → General Information`, 'INTERACTIONS ENDPOINT URL 칸 비우기 → Save Changes'],
      });
    } else add('account.interactions', 'ok', '슬래시 명령 받는 방식 정상 (Interactions URL 비어 있음)');
    if (a.bot_require_code_grant) {
      add('account.codegrant', 'fail', 'REQUIRES OAUTH2 CODE GRANT 가 켜져 있어서 초대 링크로 봇을 못 넣어요', {
        fix: [`Developer Portal(${PORTAL}) → 내 봇 → Bot 탭`, 'REQUIRES OAUTH2 CODE GRANT 끄기 → Save Changes'],
      });
    }
  } else {
    add('account.intent', 'info', `앱 설정을 못 읽었어요 (HTTP ${app.status}) — 접속엔 지장 없음`);
  }

  if (gw.ok && gw.json?.session_start_limit) {
    const s = gw.json.session_start_limit;
    result.sessions = s;
    const reset = Math.ceil((s.reset_after || 0) / 60000);
    if (s.remaining <= 0) {
      add('account.sessions', 'fail', `오늘 디스코드 접속 횟수를 다 썼어요 (0/${s.total}) — ${reset}분 뒤 풀림`, {
        detail: '봇이 계속 꺼졌다 켜지면(재시작 반복) 하루 한도가 빨리 닳아요',
        fix: ['풀리는 즉시 자동으로 접속해요', 'Render → Logs 에서 재시작이 반복되는지 확인'],
      });
    } else if (s.remaining < 30) {
      add('account.sessions', 'warn', `오늘 남은 접속 횟수가 적어요 (${s.remaining}/${s.total}) — ${reset}분 뒤 초기화`, {
        fix: ['재시작이 반복되고 있는지 Render → Logs 확인'],
      });
    } else add('account.sessions', 'ok', `오늘 접속 가능 횟수 ${s.remaining}/${s.total}`);
  } else if (gw.status === 429 || looksBanned(gw.status, gw.type, gw.text)) {
    result.retryAfterSec = Math.max(result.retryAfterSec, gw.retry || 0);
    const ban = looksBanned(gw.status, gw.type, gw.text);
    if (ban) result.banned = true;
    add('account.sessions', 'fail', `게이트웨이 정보(/gateway/bot) 요청이 막혔어요 (HTTP ${gw.status}${gw.retry ? ` · ${Math.ceil(gw.retry / 60)}분 대기` : ''})`, {
      detail: '봇 접속 첫 단계가 이 요청이라, 여기서 막히면 discord.js 가 조용히 멈춰요',
      fix: ban ? BAN_FIX : ['잠깐 기다리면 자동으로 다시 시도해요'],
    });
  }

  if (guilds.ok && Array.isArray(guilds.json)) {
    result.guilds = guilds.json;
    const appId = result.app?.id || result.me?.id;
    if (!guilds.json.length) {
      add('account.guilds', 'fail', '봇이 아직 어느 서버에도 안 들어가 있어요', {
        detail: '토큰·접속이 정상이어도 서버에 초대를 안 하면 디스코드에서 봇이 안 보여요',
        fix: [`이 링크 열고 서버 선택 → 승인: ${inviteUrl(appId)}`],
        data: { invite: inviteUrl(appId) },
      });
    } else {
      const names = guilds.json.map((g) => g.name).slice(0, 5).join(', ');
      add('account.guilds', 'ok', `들어가 있는 서버 ${guilds.json.length}개: ${names}${guilds.json.length > 5 ? ' …' : ''}`, {
        data: { invite: inviteUrl(appId) },
      });
      // 접속 전에도 서버 권한은 미리 확인 가능 (permissions 필드)
      for (const g of guilds.json.slice(0, 10)) {
        if (g.permissions == null) continue;
        const miss = missing(g.permissions, GUILD_NEEDS).filter((n) => n.level !== 'info');
        if (!miss.length) continue;
        add(`account.perm.${g.id}`, worst(miss), `${g.name}: 봇 역할에 빠진 권한 — ${miss.map((n) => n.name).join(', ')}`, {
          fix: [
            `서버 설정 → 역할 → 봇 역할 → ${miss.map((n) => n.name).join(', ')} 켜기`,
            `또는 이 링크로 다시 초대하면 권한이 자동으로 맞춰져요: ${inviteUrl(appId)}`,
          ],
        });
      }
    }
  }
  return { checks: out, result };
}

module.exports = { run, inviteUrl, FLAG };
