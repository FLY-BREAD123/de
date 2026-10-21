'use strict';
// ⌨️ "/ 쳤는데 명령어가 안 떠요" 검사 — 디스코드에 실제로 등록된 명령 목록을 다시 받아오고,
//    명령을 안 보이게 막는 설정(@everyone 권한, 채널 권한, 서버 설정 → 연동)을 전부 확인

const { PermissionFlagsBits, ApplicationCommandPermissionType, ChannelType } = require('discord.js');

const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildForum]);

async function run(guild, { expected }) {
  const out = [];
  const group = `guild:${guild.id}`;
  const add = (key, status, title, extra = {}) =>
    out.push({ id: `guild.${guild.id}.${key}`, group, groupLabel: `서버 · ${guild.name}`, status, title, ...extra });

  // 1) 디스코드에 실제 등록된 명령
  let cmds = null;
  try {
    cmds = await guild.commands.fetch();
  } catch (err) {
    add('cmdlist', 'fail', `디스코드에서 명령 목록을 못 읽었어요 (${err.code ?? ''} ${err.message})`, {
      fix: ['초대할 때 applications.commands 권한이 빠졌을 수 있어요 → /diag 의 봇 초대 링크로 다시 초대'],
    });
  }
  if (cmds) {
    const names = [...cmds.values()].map((c) => c.name);
    const missing = expected.filter((n) => !names.includes(n));
    const extra = names.filter((n) => !expected.includes(n));
    if (!names.length) {
      add('cmdlist', 'fail', '디스코드에 등록된 슬래시 명령이 0개예요 — / 쳐도 안 뜨는 이유', {
        fix: ['Render → Manual Deploy → Deploy latest commit (켜질 때 다시 등록돼요)', '같은 토큰을 쓰는 다른 봇 코드가 명령을 지웠을 수 있어요 → 다른 곳에서 돌고 있는 봇 끄기'],
      });
    } else if (missing.length || extra.length) {
      add('cmdlist', 'warn', `등록된 명령이 이 봇 코드와 달라요${missing.length ? ` · 빠짐: /${missing.join(' /')}` : ''}${extra.length ? ` · 낯선 명령: /${extra.join(' /')}` : ''}`, {
        detail: '같은 토큰을 쓰는 다른 봇 코드가 명령을 덮어쓴 것 같아요',
        fix: ['다른 곳(예전 Render 서비스, 내 PC)에서 같은 토큰으로 돌고 있는 봇 끄기', 'Render → Manual Deploy → Deploy latest commit'],
      });
    } else {
      add('cmdlist', 'ok', `디스코드에 실제 등록 확인 — /${names.join(' /')}`);
    }
  }

  // 2) @everyone 의 "앱 명령어 사용" 권한 (꺼져 있으면 일반 멤버는 / 목록에 봇 명령이 안 보임)
  const everyone = guild.roles.everyone;
  const canUse = (perm) => perm?.has(PermissionFlagsBits.UseApplicationCommands) ?? true;
  if (everyone && !canUse(everyone.permissions)) {
    add('cmdperm', 'fail', '@everyone 역할에 "앱 명령어 사용" 권한이 꺼져 있어서 일반 멤버는 / 명령이 안 보여요', {
      detail: '관리자는 보이는데 다른 사람들은 안 보이는 경우 이게 원인이에요',
      fix: ['서버 설정 → 역할 → @everyone → 권한 → "앱 명령어 사용" 켜기 → 변경사항 저장'],
    });
  } else if (everyone) {
    const blocked = guild.channels.cache.filter((ch) => {
      if (!TEXT_TYPES.has(ch.type)) return false;
      const p = ch.permissionsFor(everyone);
      return p?.has(PermissionFlagsBits.ViewChannel) && !canUse(p);
    });
    if (blocked.size) {
      const list = [...blocked.values()].slice(0, 8).map((c) => `#${c.name}`).join(', ');
      add('cmdperm', 'warn', `이 채널에서는 / 명령이 안 보여요: ${list}${blocked.size > 8 ? ' …' : ''}`, {
        fix: ['그 채널 설정(톱니) → 권한 → @everyone → "앱 명령어 사용" ✅ 또는 / (기본값)으로'],
      });
    } else {
      add('cmdperm', 'ok', '@everyone 이 모든 채널에서 / 명령 사용 가능');
    }
  }

  // 3) 서버 설정 → 연동(Integrations) → 봇 → 명령어 권한
  try {
    const all = await guild.commands.permissions.fetch({});
    const appId = guild.client.application?.id || guild.client.user.id;
    const allChannels = (BigInt(guild.id) - 1n).toString();
    const describe = (perms) => {
      const bad = [];
      for (const p of perms || []) {
        if (p.permission) continue;
        if (p.type === ApplicationCommandPermissionType.Role && p.id === guild.id) bad.push('@everyone 사용 금지');
        else if (p.type === ApplicationCommandPermissionType.Channel && p.id === allChannels) bad.push('모든 채널에서 금지');
        else if (p.type === ApplicationCommandPermissionType.Channel) bad.push(`#${guild.channels.cache.get(p.id)?.name || p.id} 금지`);
        else if (p.type === ApplicationCommandPermissionType.Role) bad.push(`@${guild.roles.cache.get(p.id)?.name || p.id} 금지`);
      }
      return bad;
    };
    const appBad = describe(all.get(appId));
    const cmdBad = [];
    for (const [id, perms] of all) {
      if (id === appId) continue;
      const bad = describe(perms);
      if (bad.length) cmdBad.push(`/${cmds?.get(id)?.name || id}: ${bad.join(', ')}`);
    }
    if (appBad.length) {
      add('integration', 'fail', `서버 설정 → 연동에서 이 봇 명령이 막혀 있어요 (${appBad.join(', ')})`, {
        fix: ['서버 설정 → 연동(Integrations) → 이 봇 → 역할·채널의 ✕ 를 ✓ 로 바꾸기 (또는 "모든 채널" 허용)'],
      });
    } else if (cmdBad.length) {
      add('integration', 'warn', `일부 명령이 연동 설정에서 막혀 있어요 — ${cmdBad.slice(0, 4).join(' · ')}`, {
        fix: ['서버 설정 → 연동(Integrations) → 이 봇 → 해당 명령 권한 수정'],
      });
    } else {
      add('integration', 'ok', '서버 연동 설정에서 막힌 명령 없음');
    }
  } catch (err) {
    if (err.code !== 10066) add('integration', 'info', `연동 권한을 못 읽었어요 (${err.code ?? ''} ${err.message}) — 접속엔 지장 없음`);
    else add('integration', 'ok', '서버 연동 설정에서 막힌 명령 없음');
  }
  return out;
}

module.exports = { run };
