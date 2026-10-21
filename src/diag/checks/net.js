'use strict';
// 🌐 네트워크 검사 — 디스코드 주소 찾기(DNS), API 연결, IP 차단 여부(Cloudflare), 게이트웨이 웹소켓
//    토큰 없이 하는 검사라 디스코드 "잘못된 요청" 횟수를 안 늘림

const dns = require('dns').promises;
const { STATUS } = require('../explain');

const UA = 'DiscordBot (https://github.com/discordjs/discord.js, 14) fifa-war-bot-diag';

const BAN_FIX = [
  'Render 무료 서버는 다른 사람들 봇과 IP를 같이 써요. 그중 누가 디스코드에 요청을 너무 많이 보내면 그 IP가 통째로 잠깐 막혀요 (내 코드·토큰 문제 아님)',
  '기다리면 자동으로 다시 검사해서 풀리는 즉시 접속해요 (보통 1시간 안에 풀림)',
  '빨리 풀려면: Render → Manual Deploy → Deploy latest commit (다른 서버에 배정되면 IP가 바뀜)',
  '계속 막히면: Render 에서 새 Web Service 를 Region = Singapore 로 만들기',
];

async function timed(fn) {
  const t = Date.now();
  try {
    const value = await fn();
    return { ok: true, value, ms: Date.now() - t };
  } catch (error) {
    return { ok: false, error, ms: Date.now() - t };
  }
}

/** Cloudflare 차단 응답인지 (HTML + 1015/1020/Access denied) */
function looksBanned(status, type, body) {
  if (status !== 429 && status !== 403) return false;
  return /text\/html/i.test(type || '') || /cloudflare|error code: 10(15|20)|access denied|you are being rate limited/i.test(body || '');
}

function minutes(sec) {
  if (!sec) return '';
  if (sec < 90) return `${sec}초`;
  return `약 ${Math.ceil(sec / 60)}분`;
}

async function run(cfg) {
  const out = [];
  const add = (id, status, title, extra = {}) => out.push({ id, group: 'net', status, title, ...extra });
  const api = cfg.DISCORD_API;
  const origin = new URL(api).origin;
  const host = new URL(api).hostname;
  const result = { banned: false, retryAfterSec: 0, reachable: false, gatewayUrl: '', netError: null };

  // 1) DNS
  if (!/^(\d+\.){3}\d+$|^localhost$/.test(host)) {
    const d = await timed(() => dns.lookup(host));
    if (d.ok) add('net.dns', 'ok', `${host} 주소 찾기 ${d.ms}ms (${d.value.address})`);
    else {
      add('net.dns', 'fail', `${host} 주소를 못 찾아요 (DNS 실패: ${d.error.code || d.error.message})`, {
        fix: ['Render 서버 네트워크 문제예요. 자동으로 다시 검사해요', '계속되면 Render → Manual Deploy → Deploy latest commit'],
      });
      result.netError = 'dns';
      return { checks: out, result };
    }
  }

  // 2) API 연결 (토큰 없이) + IP 차단 확인
  const h = await timed(async () => {
    const res = await fetch(`${api}/v10/gateway`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    const body = await res.text();
    return { status: res.status, type: res.headers.get('content-type'), retry: Number(res.headers.get('retry-after')) || 0, body };
  });
  if (!h.ok) {
    const code = h.error?.cause?.code || h.error?.name || h.error?.message;
    add('net.https', 'fail', `디스코드 API 에 연결이 안 돼요 (${code})`, {
      detail: `${api}/v10/gateway · ${h.ms}ms`,
      fix: ['Render 서버 → 디스코드 사이 네트워크 문제예요. 자동으로 다시 검사해요', `디스코드 장애 확인: ${STATUS}`],
    });
    result.netError = 'https';
  } else if (looksBanned(h.value.status, h.value.type, h.value.body)) {
    const ray = (h.value.body.match(/Ray ID:?\s*(?:<[^>]*>)?\s*([0-9a-f]{16})/i) || [])[1];
    const code = (h.value.body.match(/error code:?\s*(\d{4})/i) || [])[1];
    result.banned = true;
    result.retryAfterSec = h.value.retry;
    add(
      'net.https',
      'fail',
      `디스코드가 이 서버의 IP를 차단했어요 (HTTP ${h.value.status}${code ? ` · Cloudflare ${code}` : ''}${h.value.retry ? ` · ${minutes(h.value.retry)} 남음` : ''})`,
      { detail: `봇 코드가 디스코드에 닿기 전에 막혀요${ray ? ` · Ray ID ${ray}` : ''}`, fix: BAN_FIX },
    );
  } else if (h.value.status === 429) {
    result.retryAfterSec = h.value.retry || 30;
    add('net.https', 'warn', `디스코드 레이트리밋 (HTTP 429 · ${minutes(result.retryAfterSec)} 대기)`, {
      fix: ['잠깐 기다리면 자동으로 풀려요'],
    });
    result.reachable = true;
  } else if (h.value.status >= 500) {
    add('net.https', 'fail', `디스코드 서버 오류 (HTTP ${h.value.status})`, { fix: [`디스코드 장애 확인: ${STATUS}`, '자동으로 다시 검사해요'] });
    result.netError = 'discord5xx';
  } else if (h.value.status === 200) {
    let url = '';
    try {
      url = JSON.parse(h.value.body).url || '';
    } catch {
      /* 무시 */
    }
    result.gatewayUrl = url;
    result.reachable = true;
    add('net.https', 'ok', `디스코드 API 연결 정상 (${h.ms}ms)`);
  } else {
    add('net.https', 'warn', `디스코드 API 응답이 이상해요 (HTTP ${h.value.status})`, { detail: h.value.body.slice(0, 120) });
    result.reachable = true;
  }

  // 3) 이 서버의 바깥 IP (디스코드 앞단 Cloudflare 가 보는 IP)
  const ip = await timed(async () => {
    const res = await fetch(`${origin}/cdn-cgi/trace`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) });
    const text = await res.text();
    const kv = Object.fromEntries(text.split('\n').map((l) => l.split('=')).filter((p) => p.length === 2));
    if (!kv.ip) throw new Error('no ip');
    return kv;
  });
  if (ip.ok) {
    add('net.ip', 'info', `이 서버의 바깥 IP ${ip.value.ip}${ip.value.colo ? ` · 디스코드 접속 지점 ${ip.value.colo}` : ''}`, {
      detail: result.banned ? '이 IP가 막힌 거예요. 재배포 후 IP가 바뀌면 풀릴 수 있어요' : '',
    });
  }

  // 4) 게이트웨이 웹소켓 (HELLO 만 받고 끊음 → 접속 한도 안 씀)
  if (result.reachable) {
    const url = result.gatewayUrl || 'wss://gateway.discord.gg';
    const g = await probeGateway(url, 10000);
    if (g.ok) add('net.gateway', 'ok', `게이트웨이 웹소켓 연결 정상 (HELLO ${g.ms}ms)`);
    else {
      add('net.gateway', 'fail', `게이트웨이 웹소켓 연결 실패 — ${g.reason}`, {
        detail: url,
        fix: [
          'API(REST)는 되는데 웹소켓만 막힌 상태예요',
          'Render → Manual Deploy → Deploy latest commit 으로 다른 서버에 다시 올리기',
          '계속되면 새 Web Service 를 Region = Singapore 로 만들기',
        ],
      });
      result.gatewayBlocked = true;
    }
  }
  return { checks: out, result };
}

function loadWebSocket() {
  try {
    return require('ws');
  } catch {
    return globalThis.WebSocket || null;
  }
}

/** 게이트웨이에 붙어서 HELLO(op 10)만 확인 */
function probeGateway(url, timeoutMs) {
  const WS = loadWebSocket();
  if (!WS) return Promise.resolve({ ok: false, reason: '웹소켓 모듈 없음' });
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    let sock;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock?.close(1000);
      } catch {
        /* 무시 */
      }
      resolve({ ms: Date.now() - t0, ...r });
    };
    const timer = setTimeout(() => finish({ ok: false, reason: `${Math.round(timeoutMs / 1000)}초 동안 응답 없음` }), timeoutMs);
    try {
      const sep = url.includes('?') ? '&' : '?';
      sock = new WS(`${url}${sep}v=10&encoding=json`);
    } catch (err) {
      finish({ ok: false, reason: err.message });
      return;
    }
    const onMsg = (data) => {
      try {
        const p = JSON.parse(typeof data === 'string' ? data : data?.data ?? String(data));
        if (p.op === 10) finish({ ok: true, interval: p.d?.heartbeat_interval });
      } catch {
        /* 무시 */
      }
    };
    if (typeof sock.on === 'function') {
      sock.on('message', (d) => onMsg(d.toString()));
      sock.on('error', (e) => finish({ ok: false, reason: e.code || e.message }));
      sock.on('close', (code) => finish({ ok: false, reason: `연결이 바로 끊김 (code ${code})` }));
      sock.on('unexpected-response', (_req, res) => finish({ ok: false, reason: `HTTP ${res.statusCode} 로 거절됨` }));
    } else {
      sock.onmessage = (ev) => onMsg(ev.data);
      sock.onerror = () => finish({ ok: false, reason: '연결 오류' });
      sock.onclose = (ev) => finish({ ok: false, reason: `연결이 바로 끊김 (code ${ev.code})` });
    }
  });
}

module.exports = { run, probeGateway, looksBanned, BAN_FIX };
