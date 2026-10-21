'use strict';
// 🩺 자가진단 — 봇이 안 켜지거나 이상할 때 "정확히 뭐가 문제인지 + 어떻게 고치는지" 알려줌
//
//   checks/env.js      환경변수·토큰 형식·Node·셀프핑
//   checks/net.js      DNS·디스코드 API·IP 차단(Cloudflare)·게이트웨이 웹소켓
//   checks/account.js  토큰 인증·인텐트·Interactions URL·초대 설정·접속 한도·서버 목록
//   checks/guild.js    서버별 권한·경보 채널·역할 핑·슬래시 명령·전적 백업
//   tracker.js         접속 단계 추적 → 멈춘 단계 분석
//   explain.js         오류 코드 → 한국어 설명·해결법
//   errors.js          실행 중 오류 기록
//   print.js           Render 로그 출력
//   page.html          /diag 웹 페이지
//
//   결과는 Render 로그, https://(주소)/diag, 디스코드 /진단 명령 세 곳에서 볼 수 있음

const { EmbedBuilder } = require('discord.js');
const envCheck = require('./checks/env');
const netCheck = require('./checks/net');
const accountCheck = require('./checks/account');
const guildCheck = require('./checks/guild');
const { LoginTracker } = require('./tracker');
const { explainError, closeCode } = require('./explain');
const errors = require('./errors');
const { print } = require('./print');

const GROUPS = [
  ['env', '환경'],
  ['net', '네트워크'],
  ['account', '봇 계정'],
  ['gateway', '디스코드 접속'],
];
const RANK = { fail: 0, warn: 1, wait: 2, info: 3, ok: 4, skip: 5 };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const UNRECOVERABLE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

class Diagnostics {
  constructor({ cfg, runtime, store, commandState }) {
    this.cfg = cfg;
    this.runtime = runtime;
    this.store = store;
    this.commandState = commandState; // Map<guildId, {ok,count,error,code}>
    this.checks = new Map();
    this.tracker = new LoginTracker();
    this.account = null; // 마지막 계정 검사 결과
    this.lastRun = 0;
    this.running = null;
    this.wake = null; // 대기 중인 재시도를 바로 깨우는 함수 (index.js 가 넣어줌)
    this.loginStartedAt = 0;
  }

  // ───────── 결과 저장 ─────────
  set(c) {
    const prev = this.checks.get(c.id);
    this.checks.set(c.id, { fix: [], detail: '', ...c, at: Date.now(), first: prev?.first || Date.now() });
  }

  replaceGroup(prefix, list) {
    for (const id of [...this.checks.keys()]) if (id.startsWith(prefix)) this.checks.delete(id);
    for (const c of list) this.set(c);
  }

  setGateway(status, title, extra = {}) {
    this.set({ id: 'gateway.login', group: 'gateway', status, title, ...extra });
  }

  /** 가장 중요한 문제 1개 — 봇이 켜지는 걸 막는 순서대로 */
  headline() {
    const order = (c) => {
      if (c.group === 'env') return 0;
      if (c.group === 'net') return 1;
      if (c.id === 'account.token' || c.id === 'account.sessions') return 2;
      if (c.group === 'gateway') return 3;
      if (c.group === 'account') return 4;
      return 5; // 서버별
    };
    const list = [...this.checks.values()].filter((c) => c.status === 'fail' || c.status === 'warn');
    if (!list.length) return null;
    list.sort((a, b) => RANK[a.status] - RANK[b.status] || order(a) - order(b));
    const h = list[0];
    return { id: h.id, status: h.status, title: h.title, detail: h.detail, fix: h.fix || [] };
  }

  groups() {
    const all = [...this.checks.values()];
    const out = GROUPS.map(([id, label]) => ({ id, label, checks: all.filter((c) => c.group === id) }));
    const guildGroups = new Map();
    for (const c of all) {
      if (!c.group.startsWith('guild:')) continue;
      if (!guildGroups.has(c.group)) guildGroups.set(c.group, { id: c.group, label: c.groupLabel || '서버', checks: [] });
      guildGroups.get(c.group).checks.push(c);
    }
    return [...out, ...guildGroups.values()].filter((g) => g.checks.length);
  }

  report() {
    const c = this.runtime.client;
    const ready = !!c?.isReady?.();
    return {
      generatedAt: Date.now(),
      lastRun: this.lastRun,
      status: ready ? 'online' : this.runtime.status,
      nextRetryAt: ready ? 0 : this.runtime.nextRetryAt || 0,
      bot: ready
        ? { tag: c.user.tag, id: c.user.id, ping: c.ws.ping >= 0 ? Math.round(c.ws.ping) : null, guilds: c.guilds.cache.size, textCommands: this.runtime.textEnabled }
        : null,
      uptimeSec: Math.round(process.uptime()),
      headline: this.headline(),
      groups: this.groups(),
      timeline: this.tracker.timeline(),
      errors: errors.recent(),
    };
  }

  print(title) {
    print(this.report(), title, { publicUrl: this.cfg.PUBLIC_URL });
  }

  // ───────── 1단계: 환경 ─────────
  runEnv() {
    const list = envCheck.run(this.cfg);
    this.replaceGroup('env.', list);
    const fatal = list.find((c) => c.fatal);
    return { fatal: !!fatal, headline: fatal?.title };
  }

  // ───────── 2단계: 네트워크 + 봇 계정 → 접속해도 되는지 결정 ─────────
  async preflight() {
    const net = await netCheck.run(this.cfg);
    this.replaceGroup('net.', net.checks);
    let acc = { checks: [], result: {} };
    if (!net.result.banned && !net.result.netError) {
      acc = await accountCheck.run(this.cfg, { botIdFromToken: envCheck.botIdFromToken });
      this.replaceGroup('account.', acc.checks);
      this.account = acc.result;
    } else {
      this.replaceGroup('account.', [
        { id: 'account.token', group: 'account', status: 'skip', title: '네트워크 문제가 먼저라 토큰 검사는 건너뜀' },
      ]);
    }
    this.lastRun = Date.now();
    return this.decide(net.result, acc.result);
  }

  decide(net, acc) {
    const h = () => this.headline()?.title || '';
    if (net.netError) return { action: 'wait', waitMs: 30000, reason: h() };
    if (net.banned || acc.banned) {
      const sec = Math.max(net.retryAfterSec || 0, acc.retryAfterSec || 0);
      return { action: 'wait', waitMs: sec ? clamp(sec * 1000 + 2000, 60000, 10 * 60000) : 5 * 60000, reason: h() };
    }
    if (acc.netError) return { action: 'wait', waitMs: 30000, reason: h() };
    const fatal = [...this.checks.values()].find((c) => c.fatal && c.status === 'fail');
    if (fatal) return { action: 'stop', reason: fatal.title };
    if (!acc.tokenOk) return { action: 'wait', waitMs: clamp((acc.retryAfterSec || 30) * 1000, 15000, 10 * 60000), reason: h() };
    if (acc.sessions && acc.sessions.remaining <= 0) {
      return { action: 'wait', waitMs: clamp(acc.sessions.reset_after || 600000, 60000, 30 * 60000), reason: h() };
    }
    if (!acc.sessions && acc.retryAfterSec) return { action: 'wait', waitMs: clamp(acc.retryAfterSec * 1000 + 2000, 30000, 10 * 60000), reason: h() };
    return { action: 'go', contentIntent: acc.contentIntent };
  }

  // ───────── 3단계: 로그인 추적 ─────────
  loginStart(client) {
    this.tracker.reset();
    this.loginStartedAt = Date.now();
    this.setGateway('wait', '디스코드에 접속하는 중…');
    return this.tracker.attach(client);
  }

  loginReady(client) {
    const ms = Date.now() - this.loginStartedAt;
    this.tracker.markReady(ms);
    this.setGateway('ok', `온라인 — ${client.user.tag} · 접속 ${(ms / 1000).toFixed(1)}초 · 서버 ${client.guilds.cache.size}개`);
  }

  /** 접속이 오래 걸릴 때 (클라이언트는 그대로 두고 계속 재시도하게 둠) */
  loginStalled() {
    const elapsed = Date.now() - this.loginStartedAt;
    const s = this.tracker.analyzeStall(elapsed);
    this.setGateway('fail', `접속 지연 ${Math.round(elapsed / 1000)}초째 — ${s.title}`, {
      detail: `지금 단계: ${this.tracker.stageLabel()} · 디스코드 라이브러리가 자동으로 계속 재시도 중`,
      fix: s.fix,
    });
    return s;
  }

  /** 로그인 실패/멈춤 → 원인 + 다음 행동 */
  loginFailed({ error, timeout }) {
    if (timeout) {
      const s = this.tracker.analyzeStall(this.cfg.LOGIN_TIMEOUT_MS);
      this.setGateway('fail', `접속 멈춤 — ${s.title}`, { detail: `멈춘 단계: ${this.tracker.stageLabel()}`, fix: s.fix });
      return { action: 'wait', waitMs: 30000, title: s.title };
    }
    const ex = explainError(error);
    const name = error?.name || '';
    if (ex.code === 4014) {
      this.setGateway('warn', 'MESSAGE CONTENT INTENT 가 꺼져 있어서 텍스트 명령 없이 다시 접속해요', { fix: ex.fix });
      this.set({
        id: 'account.intent',
        group: 'account',
        status: 'warn',
        title: 'MESSAGE CONTENT INTENT 가 실제로는 꺼져 있어요 (4014) → "@친구 피파전쟁" 텍스트 명령 없이 접속함',
        detail: '슬래시 명령(/전쟁 등)은 정상이에요',
        fix: ex.fix,
      });
      return { action: 'fallback', title: ex.title };
    }
    if (ex.code === 401 || ex.code === 4004) {
      this.setGateway('fail', `접속 실패 — ${ex.title}`, { fix: ex.fix, fatal: true });
      return { action: 'stop', title: ex.title };
    }
    if (name.startsWith('RateLimitError')) {
      const ms = error.retryAfter || error.timeToReset || 60000;
      this.setGateway('fail', `접속 실패 — ${ex.title}`, { fix: ex.fix });
      return { action: 'recheck', waitMs: clamp(ms + 2000, 30000, 10 * 60000), title: ex.title };
    }
    if (ex.code === 'SESSION_LIMIT') {
      const at = Date.parse((String(error?.message).match(/resets at (\S+)/) || [])[1] || '');
      const wait = Number.isFinite(at) ? at - Date.now() : 30 * 60000;
      this.setGateway('fail', `접속 실패 — ${ex.title}`, { fix: ex.fix });
      return { action: 'wait', waitMs: clamp(wait + 5000, 60000, 60 * 60000), title: ex.title };
    }
    this.setGateway('fail', `접속 실패 — ${ex.title}`, { detail: ex.raw && ex.raw !== ex.title ? `원문: ${ex.raw}` : '', fix: ex.fix });
    return { action: 'recheck', waitMs: 30000, title: ex.title };
  }

  /** 접속 후 연결이 끊겼을 때 */
  disconnected(code) {
    const c = closeCode(code);
    const fatal = UNRECOVERABLE.has(code);
    this.setGateway(fatal ? 'fail' : 'warn', `연결 끊김 — ${c.title}`, { fix: c.fix });
    console.warn(`[진단] 연결 끊김: ${c.title}${c.fix.length ? `\n[진단]   → ${c.fix.join('\n[진단]   → ')}` : ''}`);
    return fatal;
  }

  // ───────── 4단계: 서버별 검사 (접속 후) ─────────
  runGuild(guild) {
    try {
      const list = guildCheck.run(guild, { cfg: this.cfg, store: this.store, commandState: this.commandState });
      this.replaceGroup(`guild.${guild.id}.`, list);
    } catch (err) {
      errors.record(err, `서버 검사(${guild.name})`, { quiet: true });
    }
  }

  runGuilds(client) {
    for (const id of [...this.checks.keys()]) {
      const gid = id.split('.')[1];
      if (id.startsWith('guild.') && !client.guilds.cache.has(gid)) this.checks.delete(id);
    }
    for (const g of client.guilds.cache.values()) this.runGuild(g);
    // 접속 후엔 서버 목록을 실제 캐시 기준으로
    const n = client.guilds.cache.size;
    const invite = accountCheck.inviteUrl(client.user.id);
    for (const id of [...this.checks.keys()]) if (id.startsWith('account.perm.')) this.checks.delete(id); // 접속 후엔 서버별 검사로 대체
    if (!n) {
      this.set({
        id: 'account.guilds',
        group: 'account',
        status: 'fail',
        title: '봇이 아직 어느 서버에도 안 들어가 있어요',
        detail: '봇은 온라인인데 서버에 초대를 안 해서 디스코드에서 안 보여요',
        fix: [`이 링크 열고 서버 선택 → 승인: ${invite}`],
      });
    } else {
      const names = client.guilds.cache.map((g) => g.name).slice(0, 5).join(', ');
      this.set({ id: 'account.guilds', group: 'account', status: 'ok', title: `들어가 있는 서버 ${n}개: ${names}${n > 5 ? ' …' : ''}` });
    }
  }

  // ───────── 다시 검사 (웹 버튼 / /진단) ─────────
  refresh({ minGapMs = 20000 } = {}) {
    if (this.running) return this.running;
    if (Date.now() - this.lastRun < minGapMs) return Promise.resolve(false);
    const client = this.runtime.client;
    if (!client?.isReady?.()) {
      // 접속 전/대기 중 → 접속 루프를 깨워서 그쪽에서 검사하게 함
      if (typeof this.wake === 'function') this.wake();
      return Promise.resolve(true);
    }
    this.running = (async () => {
      try {
        const net = await netCheck.run(this.cfg);
        this.replaceGroup('net.', net.checks);
        if (!net.result.banned && !net.result.netError) {
          const acc = await accountCheck.run(this.cfg, { botIdFromToken: envCheck.botIdFromToken });
          this.replaceGroup('account.', acc.checks);
          this.account = acc.result;
        }
        this.runGuilds(client);
        this.lastRun = Date.now();
        return true;
      } catch (err) {
        errors.record(err, '다시 검사', { quiet: true });
        return false;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  // ───────── 디스코드 /진단 임베드 ─────────
  embed(guild) {
    const ICON = { ok: '✅', warn: '⚠️', fail: '❌', info: 'ℹ️', wait: '⏳', skip: '⏭️' };
    const all = [...this.checks.values()];
    const mine = all.filter((c) => c.group === `guild:${guild.id}`);
    const global = all.filter((c) => ['env', 'net', 'account', 'gateway'].includes(c.group) && !c.id.startsWith('account.perm.'));
    const show = (c) => {
      let s = `${ICON[c.status] || '•'} ${c.title}`;
      if (c.status === 'fail' || c.status === 'warn') for (const f of (c.fix || []).slice(0, 3)) s += `\n　→ ${f}`;
      return s;
    };
    const bad = [...global, ...mine].filter((c) => c.status === 'fail' || c.status === 'warn').sort((a, b) => RANK[a.status] - RANK[b.status]);
    const worst = bad[0]?.status;
    const e = new EmbedBuilder()
      .setColor(worst === 'fail' ? this.cfg.COLORS.alert : worst === 'warn' ? this.cfg.COLORS.gold : this.cfg.COLORS.win)
      .setTitle('🩺 피파 전쟁 봇 진단')
      .setDescription(clip(bad.length ? `**핵심 문제**\n${show(bad[0])}` : '**문제 없음** — 봇이 정상이에요 ✅', 1500));
    const field = (name, list) => {
      if (!list.length) return;
      e.addFields({ name, value: clip(list.map(show).join('\n'), 1024) });
    };
    field('봇 계정 · 접속', global.filter((c) => c.group === 'account' || c.group === 'gateway'));
    const netBad = global.filter((c) => (c.group === 'net' || c.group === 'env') && c.status !== 'ok' && c.status !== 'info');
    field('환경 · 네트워크', netBad);
    field(`이 서버 (${guild.name})`, mine);
    const errs = errors.recent(guild.id).slice(0, 5);
    if (errs.length) {
      e.addFields({
        name: `최근 오류 ${errs.length}개`,
        value: clip(errs.map((x) => `<t:${Math.floor(x.at / 1000)}:R> ${x.where} — ${x.title}${x.count > 1 ? ` (x${x.count})` : ''}`).join('\n'), 1024),
      });
    }
    if (this.cfg.PUBLIC_URL && this.cfg.DIAG_PUBLIC) e.setFooter({ text: `자세히: ${this.cfg.PUBLIC_URL}/diag` });
    return e;
  }
}

function clip(s, n) {
  s = String(s);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

module.exports = { Diagnostics, errors };
