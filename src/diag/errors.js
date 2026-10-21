'use strict';
// 🧾 실행 중 오류 기록 — 어디서(명령/버튼/저장) 무슨 오류가 났는지 최근 15개를 설명과 함께 보관
//    /diag 페이지, /진단 명령, Render 로그에 그대로 보임

const { explainError } = require('./explain');

const MAX = 15;
const list = [];
const listeners = new Set();

/**
 * @param {unknown} err
 * @param {string} where 예: "/전쟁", "버튼: 수락", "백업 저장"
 * @param {object} [opt] { guildId, quiet }
 */
function record(err, where, opt = {}) {
  const ex = explainError(err);
  const item = {
    at: Date.now(),
    where: String(where || '알 수 없음'),
    guildId: opt.guildId || null,
    code: ex.code,
    title: ex.title,
    fix: ex.fix,
    raw: ex.raw,
  };
  // 같은 오류가 연달아 나면 횟수만 올림
  const last = list[0];
  if (last && last.where === item.where && last.code === item.code && last.raw === item.raw) {
    last.count = (last.count || 1) + 1;
    last.at = item.at;
  } else {
    list.unshift(item);
    if (list.length > MAX) list.length = MAX;
  }
  if (!opt.quiet) {
    console.error(`[오류] ${item.where} → ${item.title}${item.raw && item.raw !== item.title ? `\n       원문: ${item.raw}` : ''}`);
    for (const f of item.fix) console.error(`       → ${f}`);
  }
  for (const fn of listeners) {
    try {
      fn(item);
    } catch {
      /* 무시 */
    }
  }
  return item;
}

function recent(guildId) {
  return guildId ? list.filter((e) => !e.guildId || e.guildId === guildId) : [...list];
}

function onRecord(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

module.exports = { record, recent, onRecord };
