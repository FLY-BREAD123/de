'use strict';
// 🔐 봇 권한 검사 — 비트값으로 계산해서 디스코드 화면에 보이는 한국어 이름으로 알려줌

const bit = (n) => 1n << BigInt(n);
const P = {
  ADMINISTRATOR: bit(3),
  MANAGE_CHANNELS: bit(4),
  ADD_REACTIONS: bit(6),
  VIEW_CHANNEL: bit(10),
  SEND_MESSAGES: bit(11),
  EMBED_LINKS: bit(14),
  ATTACH_FILES: bit(15),
  READ_MESSAGE_HISTORY: bit(16),
  MENTION_EVERYONE: bit(17),
};

// level: fail = 없으면 봇이 제대로 안 됨 / warn = 일부 기능만 안 됨 / info = 상황에 따라
const GUILD_NEEDS = [
  { key: 'VIEW_CHANNEL', name: '채널 보기', why: '채널을 봐야 뭐든 할 수 있어요', level: 'fail' },
  { key: 'SEND_MESSAGES', name: '메시지 보내기', why: '전쟁 경보·결과 메시지', level: 'fail' },
  { key: 'EMBED_LINKS', name: '링크 첨부', why: '경보 카드(임베드)가 보이려면 필요', level: 'fail' },
  { key: 'READ_MESSAGE_HISTORY', name: '메시지 기록 보기', why: '결과 답장·전적 백업 읽기', level: 'warn' },
  { key: 'ATTACH_FILES', name: '파일 첨부', why: '전적 백업 파일 저장', level: 'warn' },
  { key: 'MANAGE_CHANNELS', name: '채널 관리', why: '#fifa-war-db 백업 채널 만들기 (없으면 재시작 때 전적 초기화)', level: 'warn' },
  { key: 'ADD_REACTIONS', name: '반응 추가', why: '텍스트 선포에 ⚔️ 반응', level: 'warn' },
  { key: 'MENTION_EVERYONE', name: '@everyone, @here, 모든 역할 멘션', why: '경보 역할 핑 (역할이 "멘션 허용"이면 필요 없음)', level: 'info' },
];

const CHANNEL_NEEDS = [
  { key: 'VIEW_CHANNEL', name: '채널 보기', level: 'fail' },
  { key: 'SEND_MESSAGES', name: '메시지 보내기', level: 'fail' },
  { key: 'EMBED_LINKS', name: '링크 첨부', level: 'fail' },
  { key: 'READ_MESSAGE_HISTORY', name: '메시지 기록 보기', level: 'warn' },
];

const BACKUP_NEEDS = [
  { key: 'VIEW_CHANNEL', name: '채널 보기', level: 'fail' },
  { key: 'SEND_MESSAGES', name: '메시지 보내기', level: 'fail' },
  { key: 'ATTACH_FILES', name: '파일 첨부', level: 'fail' },
  { key: 'READ_MESSAGE_HISTORY', name: '메시지 기록 보기', level: 'fail' },
];

const toBig = (v) => {
  if (typeof v === 'bigint') return v;
  if (v && typeof v.bitfield === 'bigint') return v.bitfield;
  try {
    return BigInt(v ?? 0);
  } catch {
    return 0n;
  }
};

function has(perms, key) {
  const p = toBig(perms);
  return (p & P.ADMINISTRATOR) !== 0n || (p & P[key]) !== 0n;
}

/** 빠진 권한 목록 */
function missing(perms, needs) {
  return needs.filter((n) => !has(perms, n.key));
}

/** 가장 심각한 수준 */
function worst(list) {
  if (list.some((n) => n.level === 'fail')) return 'fail';
  if (list.some((n) => n.level === 'warn')) return 'warn';
  return list.length ? 'info' : 'ok';
}

/**
 * REST 데이터로 채널 권한 계산 (디스코드 공식 계산 순서)
 * base: 서버 권한(역할 합), overwrites: 채널 권한 덮어쓰기, roleIds: 봇 역할들
 */
function channelPerms(base, overwrites, guildId, roleIds, memberId) {
  let p = toBig(base);
  if ((p & P.ADMINISTRATOR) !== 0n) return p;
  const ow = overwrites || [];
  const everyone = ow.find((o) => o.id === guildId);
  if (everyone) p = (p & ~toBig(everyone.deny)) | toBig(everyone.allow);
  let allow = 0n;
  let deny = 0n;
  for (const o of ow) {
    if (o.type === 0 && o.id !== guildId && roleIds.includes(o.id)) {
      allow |= toBig(o.allow);
      deny |= toBig(o.deny);
    }
  }
  p = (p & ~deny) | allow;
  const mine = ow.find((o) => o.type === 1 && o.id === memberId);
  if (mine) p = (p & ~toBig(mine.deny)) | toBig(mine.allow);
  return p;
}

module.exports = { P, GUILD_NEEDS, CHANNEL_NEEDS, BACKUP_NEEDS, has, missing, worst, channelPerms, toBig };
