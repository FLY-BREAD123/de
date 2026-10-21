'use strict';
// 🏠 서버별 검사 (봇 접속 후) — 봇 권한, 경보 채널 권한, 경보 역할 핑, 슬래시 명령 등록, 전적 백업

const { GUILD_NEEDS, CHANNEL_NEEDS, BACKUP_NEEDS, missing, worst } = require('../perms');
const { inviteUrl } = require('./account');

const ago = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  return `${Math.round(s / 3600)}시간 전`;
};

/**
 * @param {object} ctx { cfg, store, commandState: Map<guildId,{ok,count,error,expected}> }
 */
function run(guild, ctx) {
  const out = [];
  const group = `guild:${guild.id}`;
  const add = (key, status, title, extra = {}) => out.push({ id: `guild.${guild.id}.${key}`, group, groupLabel: `서버 · ${guild.name}`, status, title, ...extra });
  const me = guild.members.me;
  const invite = inviteUrl(guild.client.user.id);

  // 1) 서버 전체 권한
  if (!me) {
    add('perms', 'warn', '봇 멤버 정보를 아직 못 받았어요 — 잠시 뒤 다시 검사');
  } else {
    const miss = missing(me.permissions, GUILD_NEEDS);
    const real = miss.filter((n) => n.level !== 'info');
    if (!real.length) add('perms', 'ok', `봇 기본 권한 정상${me.permissions.has('Administrator') ? ' (관리자)' : ''}`);
    else {
      add('perms', worst(real), `봇 역할에 빠진 권한: ${real.map((n) => n.name).join(', ')}`, {
        detail: real.map((n) => `${n.name} — ${n.why}`).join(' / '),
        fix: [`서버 설정 → 역할 → "${me.roles.botRole?.name || guild.client.user.username}" 역할 → 권한에서 켜기`, `또는 이 링크로 다시 초대 (권한 자동 설정): ${invite}`],
      });
    }
  }

  // 2) 슬래시 명령 등록
  const cs = ctx.commandState.get(guild.id);
  if (!cs) add('commands', 'info', '슬래시 명령 등록 중…');
  else if (cs.ok) add('commands', 'ok', `슬래시 명령 ${cs.count}개 등록됨 (/전쟁 /전적 /랭킹 …)`);
  else {
    const missingScope = cs.code === 50001 || /Missing Access/i.test(cs.error || '');
    add('commands', 'fail', `슬래시 명령 등록 실패${cs.code ? ` (${cs.code})` : ''} — ${missingScope ? '초대할 때 applications.commands 권한이 빠졌어요' : cs.error}`, {
      fix: missingScope
        ? [`이 링크로 봇을 다시 초대 (서버에서 내보낼 필요 없음): ${invite}`, 'Render → Manual Deploy → Deploy latest commit (재시작하면 다시 등록)']
        : ['Render → Manual Deploy → Deploy latest commit (재시작하면 다시 등록)'],
    });
  }

  // 3) 경보 채널
  const st = ctx.store.peek(guild.id);
  const alertId = st?.settings?.alertChannelId || ctx.cfg.ALERT_CHANNEL_ID;
  if (!alertId) {
    add('alert', 'info', '경보 채널 미설정 → /전쟁 을 입력한 채널에 경보가 울려요', { fix: ['고정하려면 /피파설정 경보채널:#채널'] });
  } else {
    const ch = guild.channels.cache.get(alertId);
    if (!ch) {
      add('alert', 'fail', '설정된 경보 채널이 없어졌거나 봇이 못 봐요', {
        detail: `채널 ID ${alertId}`,
        fix: ['/피파설정 경보채널:#채널 로 다시 지정', '비공개 채널이면 채널 설정 → 권한 → 봇 역할 추가 → 채널 보기 허용'],
      });
    } else if (me) {
      const miss = missing(ch.permissionsFor(me), CHANNEL_NEEDS);
      if (!miss.length) add('alert', 'ok', `경보 채널 #${ch.name} — 봇 권한 정상`);
      else {
        add('alert', worst(miss), `경보 채널 #${ch.name} 에서 봇 권한 부족: ${miss.map((n) => n.name).join(', ')}`, {
          fix: [`#${ch.name} 채널 설정(톱니) → 권한 → 봇 역할 추가 → ${miss.map((n) => n.name).join(', ')} ✅ 허용`],
        });
      }
    }
  }

  // 4) 경보 역할 핑
  const roleId = st?.settings?.alertRoleId || ctx.cfg.ALERT_ROLE_ID;
  if (roleId) {
    const role = guild.roles.cache.get(roleId);
    if (!role) add('role', 'warn', '설정된 경보 역할이 지워졌어요', { fix: ['/피파설정 경보역할:@역할 로 다시 지정 또는 역할핑끄기:True'] });
    else if (!role.mentionable && !(me && me.permissions.has('MentionEveryone'))) {
      add('role', 'warn', `경보 역할 @${role.name} 핑이 안 가요 (멘션 불가 역할)`, {
        fix: [`서버 설정 → 역할 → @${role.name} → "누구나 이 역할을 @멘션하도록 허용" 켜기`, '또는 봇 역할에 "@everyone, @here, 모든 역할 멘션" 권한 주기'],
      });
    } else add('role', 'ok', `경보 역할 @${role.name} 핑 가능`);
  }

  // 5) 전적 백업
  const info = ctx.store.info(guild.id);
  if (info.mode === 'discord') {
    const ch = guild.channels.cache.get(info.channelId);
    const miss = ch && me ? missing(ch.permissionsFor(me), BACKUP_NEEDS) : [];
    if (miss.length) {
      add('backup', 'fail', `백업 채널 #${info.channelName} 에서 봇 권한 부족: ${miss.map((n) => n.name).join(', ')} → 재시작 때 전적 날아갈 수 있어요`, {
        fix: [`#${info.channelName} 채널 설정 → 권한 → 봇 역할 → ${miss.map((n) => n.name).join(', ')} 허용`],
      });
    } else if (info.lastError) {
      add('backup', 'warn', `전적 백업 오류: ${info.lastError}`, { fix: ['/diag 의 최근 오류 확인'] });
    } else {
      add('backup', 'ok', `전적 백업 #${info.channelName}${info.lastSavedAt ? ` · 마지막 저장 ${ago(info.lastSavedAt)}` : ' · 아직 저장할 기록 없음'}`);
    }
  } else {
    add('backup', 'warn', '전적 백업 채널이 없어요 → Render 가 재시작하면 전적이 초기화돼요', {
      fix: ['봇 역할에 "채널 관리" 권한 주기 → Render → Manual Deploy → Deploy latest commit (재시작 때 #fifa-war-db 자동 생성)', '또는 채널 직접 만들고 Render 환경변수 DATA_CHANNEL_ID 에 채널 ID 넣기'],
    });
  }
  return out;
}

module.exports = { run };
