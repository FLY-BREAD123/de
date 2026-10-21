'use strict';
// 🛰️ 디스코드 접속 과정 추적 — discord.js 내부 로그를 단계별로 기록해서
//    접속이 멈추면 "어느 단계에서 왜 멈췄는지" 정확히 알려줌

const { closeCode, explainError, STATUS } = require('./explain');

// discord.js / @discordjs/ws 디버그 문구 → 단계
const RULES = [
  [/Preparing to connect to the gateway/i, 'rest', '게이트웨이 주소 요청 (REST /gateway/bot)'],
  [/Fetched Gateway Information/i, 'fetched', '게이트웨이 주소 받음'],
  [/Session Limit Information[\s\S]*Remaining: (\d+)/i, 'limits', (m) => `접속 한도 확인 — 오늘 남은 횟수 ${m[1]}`],
  [/Connecting to (\S+)/i, 'connecting', () => '게이트웨이 웹소켓 연결 시도'],
  [/Waiting for event hello/i, 'wait-hello', 'HELLO(연결 확인 신호) 기다리는 중'],
  [/Preparing first heartbeat/i, 'hello', 'HELLO 받음 — 웹소켓 연결 성공'],
  [/Waiting for identify throttle/i, 'identify-wait', '로그인 순서 기다리는 중'],
  [/^\[WS => Shard \d+\] Identifying/i, 'identify', '로그인 정보(IDENTIFY) 보냄'],
  [/Waiting for event ready/i, 'wait-ready', 'READY(로그인 완료 신호) 기다리는 중'],
  [/Resuming session/i, 'resume', '이전 세션 이어붙이기 시도'],
  [/Invalid session/i, 'invalid-session', '세션 무효 — 다시 로그인'],
  [/Failed to connect to the gateway URL specified due to a network error/i, 'net-error', '웹소켓 연결 중 네트워크 오류'],
  [/Shard not recoverable: (\d+)/i, 'closed', (m) => `연결 끊김 — ${closeCode(Number(m[1])).title}`],
  [/gateway closed with an unexpected code (\d+)/i, 'closed', (m) => `연결 끊김 — ${closeCode(Number(m[1])).title}`],
  [/Session timed out/i, 'closed', '세션 시간 초과 — 다시 연결'],
];

class LoginTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.t0 = Date.now();
    this.events = [];
    this.stage = 'start';
    this.lastAt = this.t0;
    this.identifies = 0;
    this.closes = [];
    this.rest = []; // /gateway 관련 REST 응답
    this.rateLimits = [];
    this.errors = [];
    this.ready = false;
    this.readyAt = 0;
  }

  mark(stage, label) {
    const now = Date.now();
    this.stage = stage;
    this.lastAt = now;
    // 재시도 때문에 같은 단계가 반복되면 줄을 늘리지 않고 횟수만 셈
    const recent = this.events.slice(-8);
    const same = recent.find((e) => e.stage === stage && e.label === label);
    if (same) {
      same.count = (same.count || 1) + 1;
      same.last = now - this.t0;
      return;
    }
    this.events.push({ at: now - this.t0, stage, label });
    if (this.events.length > 40) this.events.splice(1, 1);
  }

  onDebug(msg) {
    const m0 = String(msg);
    if (/Provided token/i.test(m0)) return; // 토큰 조각이 들어있는 줄은 절대 저장 안 함
    for (const [re, stage, label] of RULES) {
      const m = m0.match(re);
      if (!m) continue;
      if (stage === 'identify') this.identifies += 1;
      if (stage === 'closed') {
        const code = Number(m[1]);
        if (Number.isFinite(code)) this.closes.push(code);
      }
      this.mark(stage, typeof label === 'function' ? label(m) : label);
      return;
    }
  }

  /** 클라이언트에 붙이기 → 떼는 함수 반환 */
  attach(client) {
    const onDebug = (m) => this.onDebug(m);
    const onRestDebug = (m) => {
      if (/Encountered unexpected 429/i.test(m)) {
        const retry = Number((String(m).match(/Retry After\s*:\s*(\d+)/i) || [])[1]) || 0;
        const url = (String(m).match(/URL\s*:\s*(\S+)/i) || [])[1] || '';
        this.rateLimits.push({ at: Date.now() - this.t0, retryAfter: retry, url });
        this.mark('rate-limited', `디스코드 레이트리밋 429 — ${Math.ceil(retry / 1000)}초 대기`);
      }
    };
    const onResponse = (req, res) => {
      if (!String(req?.route || '').startsWith('/gateway')) return;
      const status = res?.status;
      this.rest.push({ at: Date.now() - this.t0, route: req.route, status });
      if (status && status !== 200) this.mark('rest-error', `REST ${req.route} → HTTP ${status}`);
    };
    const onRateLimited = (r) => {
      this.rateLimits.push({ at: Date.now() - this.t0, retryAfter: r.retryAfter || r.timeToReset || 0, url: r.route });
    };
    const onShardError = (err) => {
      this.errors.push(explainError(err));
      this.mark('shard-error', `웹소켓 오류 — ${explainError(err).title}`);
    };
    const onDisconnect = (ev) => {
      if (ev?.code) this.closes.push(ev.code);
    };
    client.on('debug', onDebug);
    client.on('shardError', onShardError);
    client.on('shardDisconnect', onDisconnect);
    client.rest.on('restDebug', onRestDebug);
    client.rest.on('response', onResponse);
    client.rest.on('rateLimited', onRateLimited);
    return () => {
      client.off('debug', onDebug);
      client.off('shardError', onShardError);
      client.off('shardDisconnect', onDisconnect);
      client.rest.off('restDebug', onRestDebug);
      client.rest.off('response', onResponse);
      client.rest.off('rateLimited', onRateLimited);
    };
  }

  markReady(ms) {
    this.ready = true;
    this.readyAt = Date.now();
    this.mark('ready', `READY — 로그인 완료 (${(ms / 1000).toFixed(1)}초)`);
  }

  /** 접속이 멈췄을 때: 마지막 단계 보고 원인 판단 */
  analyzeStall(timeoutMs) {
    const sec = Math.round(timeoutMs / 1000);
    const lastClose = this.closes[this.closes.length - 1];
    const idle = Math.round((Date.now() - this.lastAt) / 1000);
    if (lastClose && lastClose >= 4000) {
      const c = closeCode(lastClose);
      return { title: `디스코드가 접속을 끊음 — ${c.title}`, fix: c.fix, stage: this.stage };
    }
    if (this.rateLimits.length || this.rest.some((r) => r.status === 429)) {
      const ra = this.rateLimits[this.rateLimits.length - 1]?.retryAfter || 0;
      return {
        title: `디스코드 레이트리밋(429)에 걸려 접속이 멈춤${ra ? ` — ${Math.ceil(ra / 60000)}분 대기 요구` : ''}`,
        fix: [
          'Render 무료 서버는 다른 봇들과 IP를 같이 써서, 그 IP가 디스코드에 잠깐 막힐 수 있어요 (코드·토큰 문제 아님)',
          '기다리면 자동으로 다시 접속해요',
          '빨리 풀려면 Render → Manual Deploy → Deploy latest commit',
          '계속 막히면 새 Web Service 를 Region = Singapore 로 만들기',
        ],
        stage: this.stage,
      };
    }
    const wsTrouble = this.events.some((e) => e.stage === 'net-error') || (this.stage === 'closed' && lastClose && lastClose < 4000);
    if (wsTrouble) {
      return {
        title: `게이트웨이 웹소켓(wss://gateway.discord.gg) 연결이 계속 끊겨요${lastClose ? ` (code ${lastClose})` : ''}`,
        fix: [
          'REST(API)는 되는데 웹소켓만 안 붙는 상태 — Render 서버 네트워크 문제일 가능성이 커요',
          'Render → Manual Deploy → Deploy latest commit 으로 다른 서버에 다시 올리기',
          '계속되면 새 Web Service 를 Region = Singapore 로 만들기',
        ],
        stage: this.stage,
      };
    }
    switch (this.stage) {
      case 'start':
      case 'rest':
        return {
          title: `디스코드 API(/gateway/bot) 응답을 ${sec}초째 못 받음`,
          fix: ['디스코드 API가 막혔거나 느려요 — /diag 의 네트워크 항목 확인', `디스코드 장애 확인: ${STATUS}`, '자동으로 다시 시도해요'],
          stage: this.stage,
        };
      case 'fetched':
      case 'limits':
      case 'connecting':
      case 'wait-hello':
      case 'net-error':
        return {
          title: '게이트웨이 웹소켓(wss://gateway.discord.gg) 연결이 안 돼요',
          fix: [
            'REST는 되는데 웹소켓만 막힌 상태 — Render 서버 네트워크 문제일 가능성이 커요',
            'Render → Manual Deploy → Deploy latest commit 으로 다른 서버에 다시 올리기',
            '계속되면 새 Web Service 를 Region = Singapore 로 만들기',
          ],
          stage: this.stage,
        };
      case 'hello':
      case 'identify-wait':
        return {
          title: '로그인 순서(IDENTIFY 대기열)에서 멈춤',
          fix: ['하루 접속 한도가 거의 다 찼을 때 생겨요 — /diag 의 "오늘 접속 가능 횟수" 확인', '자동으로 다시 시도해요'],
          stage: this.stage,
        };
      case 'identify':
      case 'wait-ready':
      case 'resume':
      case 'invalid-session':
        return {
          title: `로그인 정보는 보냈는데 디스코드가 READY를 안 보내요 (${this.identifies}번 시도)`,
          fix: [
            `디스코드 장애일 수 있어요: ${STATUS}`,
            '같은 토큰으로 다른 곳에서 봇이 계속 재시작 중이면 생길 수 있어요 → 예전 서비스 끄기',
            '자동으로 다시 시도해요',
          ],
          stage: this.stage,
        };
      default:
        return {
          title: `접속이 "${this.stageLabel()}" 단계에서 ${idle}초째 멈춤`,
          fix: ['자동으로 다시 시도해요', '계속되면 /diag 화면 캡처해서 보내줘'],
          stage: this.stage,
        };
    }
  }

  stageLabel() {
    return this.events[this.events.length - 1]?.label || '시작 전';
  }

  timeline() {
    return this.events.map((e) => ({ at: e.at, last: e.last || e.at, label: e.label, count: e.count || 1, stage: e.stage }));
  }
}

module.exports = { LoginTracker };
