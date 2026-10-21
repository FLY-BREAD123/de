'use strict';
// ⚔️ 피파 전쟁 봇 — Render 무료 웹서비스용
//   /전쟁 상대:@친구  (또는 "@친구 피파전쟁")  →  상대 DM + 경보 채널 사이렌 → 수락 → 스코어 입력 → 상대 확인 → 리그 반영
//
//   켜지는 순서:  웹서버(포트) → [진단] 환경 → [진단] 네트워크·봇 계정 → 디스코드 접속(단계 추적) → [진단] 서버별 검사
//   어디서 막히든 Render 로그 / https://(주소)/diag / 디스코드 /진단 에 "정확한 문제 + 해결법"이 떠요

const cfg = require('./config');
const { Client, GatewayIntentBits, Events, ActivityType, Options, MessageFlags } = require('discord.js');
const { Store } = require('./store');
const war = require('./war');
const commands = require('./commands');
const text = require('./text');
const web = require('./web');
const { Diagnostics, errors } = require('./diag');

const runtime = { client: null, status: 'starting', error: '', textEnabled: false, nextRetryAt: 0 };
const store = new Store(() => runtime.client);
const diag = new Diagnostics({ cfg, runtime, store, commandState: commands.state, commandNames: commands.JSON_DEFS.map((d) => d.name) });

war.init({ store, getClient: () => runtime.client });
commands.init({ store, runtime, diag });
text.init({ store, runtime });

// 포트부터 연다 → Render가 배포 성공으로 인식
web.start({ runtime, store, diag });

// ───────── 상태 표시 ─────────
function setStatus(status, msg) {
  runtime.status = status;
  runtime.error = msg || '';
}

// 기다리는 중에 /diag "다시 검사" 누르면 바로 깨어나는 sleep
function sleepUntil(ms) {
  runtime.nextRetryAt = Date.now() + ms;
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      diag.wake = null;
      runtime.nextRetryAt = 0;
      resolve();
    }
    diag.wake = done;
  });
}

const fmt = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)}분` : `${Math.round(ms / 1000)}초`);

// ───────── 서버별 준비 ─────────
async function setupGuild(guild) {
  try {
    const st = await store.ensure(guild.id);
    war.rearm(guild.id);
    await commands.register(guild);
    const info = store.info(guild.id);
    console.log(
      `[store] ${guild.name}: ${
        info.mode === 'discord' ? `#${info.channelName} 백업 사용` : '⚠️ 로컬 저장만 (재시작 시 초기화 위험)'
      } · 플레이어 ${Object.keys(st.players).length}명 · 진행 중 ${Object.keys(st.active).length}건`,
    );
  } catch (err) {
    errors.record(err, `서버 준비(${guild.name})`, { guildId: guild.id });
  }
  diag.runGuild(guild);
  await diag.checkCommands(guild);
}

async function route(i) {
  if (i.isChatInputCommand()) return commands.handle(i);
  if (i.isButton() && i.customId.startsWith('fw|')) return war.handleButton(i);
  if (i.isModalSubmit() && i.customId.startsWith('fwm|')) return war.handleModal(i);
}

function whereOf(i) {
  if (i.isChatInputCommand?.()) return `/${i.commandName}`;
  if (i.isButton?.()) return `버튼(${String(i.customId).split('|')[1] || '?'})`;
  if (i.isModalSubmit?.()) return '결과 입력창';
  return '상호작용';
}

async function interactionError(i, err) {
  const item = errors.record(err, whereOf(i), { guildId: i.guildId });
  if (item.code === 40060) {
    diag.set({
      id: 'gateway.duplicate',
      group: 'gateway',
      status: 'fail',
      title: '같은 토큰으로 봇이 2개 켜져 있어요 (버튼에 다른 봇이 먼저 응답함)',
      fix: item.fix,
    });
  }
  if (!i.isRepliable()) return;
  const payload = {
    content: `⚠️ ${item.title}${item.fix[0] ? `\n→ ${item.fix[0]}` : ''}\n-# 관리자는 /진단 으로 자세히 볼 수 있어요`,
    flags: MessageFlags.Ephemeral,
  };
  try {
    if (i.deferred || i.replied) await i.followUp(payload);
    else await i.reply(payload);
  } catch {
    /* 이미 만료된 상호작용 */
  }
}

// ───────── 디스코드 클라이언트 ─────────
function createClient(withContent) {
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
  if (withContent) intents.push(GatewayIntentBits.MessageContent);

  const client = new Client({
    intents,
    makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 50 }),
    sweepers: Options.DefaultSweeperSettings,
    presence: { activities: [{ name: 'fifa', type: ActivityType.Custom, state: '⚔️ /전쟁 으로 피파 전쟁 선포' }] },
    // 게이트웨이 정보 요청이 레이트리밋(=IP 차단)에 걸리면 조용히 몇 시간 기다리지 말고 바로 에러 → 진단에 표시
    rest: { api: cfg.DISCORD_API, rejectOnRateLimit: (r) => String(r.route || '').startsWith('/gateway') },
  });

  client.once(Events.ClientReady, async (c) => {
    if (runtime.client !== client) {
      // 멈춘 줄 알고 버린 클라이언트가 뒤늦게 붙은 경우 → 중복 접속 방지
      client.destroy().catch(() => {});
      return;
    }
    setStatus('online', '');
    runtime.textEnabled = withContent;
    diag.loginReady(c);
    console.log(`[bot] ✅ ${c.user.tag} 로그인 · 서버 ${c.guilds.cache.size}개 · 텍스트 명령 ${withContent ? 'ON' : 'OFF'}`);
    await Promise.all(c.guilds.cache.map((g) => setupGuild(g)));
    diag.runGuilds(c);
    diag.print('접속 후 자가진단');
  });
  client.on(Events.GuildCreate, async (g) => {
    await setupGuild(g);
    diag.runGuilds(client);
    console.log(`[bot] ➕ 새 서버 들어감: ${g.name}`);
  });
  client.on(Events.GuildDelete, (g) => {
    diag.runGuilds(client);
    console.log(`[bot] ➖ 서버에서 나감: ${g.name || g.id}`);
  });
  client.on(Events.InteractionCreate, (i) => route(i).catch((err) => interactionError(i, err)));
  if (withContent) {
    client.on(Events.MessageCreate, (m) => text.handle(m).catch((err) => errors.record(err, '텍스트 명령', { guildId: m.guildId })));
  }
  client.on(Events.Error, (err) => errors.record(err, '디스코드 클라이언트'));
  client.on(Events.ShardDisconnect, (ev) => {
    if (runtime.client !== client || !client.isReady()) return; // 접속 중 끊김은 접속 루프가 처리
    const fatal = diag.disconnected(ev?.code);
    setStatus(fatal ? 'error' : 'reconnecting', diag.headline()?.title);
    if (fatal) diag.print('연결 끊김 진단');
  });
  client.on(Events.ShardReconnecting, () => {
    if (runtime.client === client && client.isReady()) setStatus('reconnecting', '디스코드에 다시 연결하는 중…');
  });
  client.on(Events.ShardResume, () => {
    if (runtime.client === client) {
      setStatus('online', '');
      diag.setGateway('ok', `온라인 — ${client.user?.tag} · 다시 연결됨`);
    }
  });
  client.on(Events.ShardReady, () => {
    if (runtime.client === client && client.isReady()) setStatus('online', '');
  });
  return client;
}

// 접속이 오래 걸리면 끊지 않고(끊으면 discord.js 가 꼬임) 멈춘 단계를 진단해서 보여줌
function watchStall(client) {
  let n = 0;
  const timer = setInterval(() => {
    if (client.isReady() || runtime.client !== client) return;
    n += 1;
    const s = diag.loginStalled();
    setStatus('error', s.title);
    if (n === 1) diag.print('접속 지연 진단 — 자동 재시도는 계속돼요');
    else console.warn(`[진단] 아직 접속 못 함 (${Math.round((n * cfg.LOGIN_TIMEOUT_MS) / 60000)}분째) — ${s.title}`);
  }, cfg.LOGIN_TIMEOUT_MS);
  return () => clearInterval(timer);
}

const destroySafe = (client) =>
  Promise.race([client.destroy().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);

// ───────── 시작 ─────────
async function start() {
  console.log(`[bot] 피파 전쟁 봇 시작 · Node ${process.versions.node}`);
  const env = diag.runEnv();
  if (env.fatal) {
    setStatus('error', env.headline);
    diag.setGateway('skip', '환경 문제를 먼저 고쳐야 접속할 수 있어요');
    diag.print('자가진단 — 시작 실패');
    return;
  }

  let withContent = cfg.TEXT_COMMANDS;
  for (let round = 1; ; round++) {
    // 1) 접속 전 검사
    setStatus(round === 1 ? 'starting' : 'error', '디스코드 연결 상태 검사 중…');
    diag.setGateway('wait', '접속 전 검사 중…');
    const pf = await diag.preflight();
    if (pf.action === 'stop') {
      setStatus('error', pf.reason);
      diag.setGateway('skip', '위 문제를 고치면 자동으로 접속해요 (Render 환경변수 저장 = 자동 재시작)');
      diag.print('접속 전 자가진단 — 접속 중단');
      return;
    }
    if (pf.action === 'wait') {
      setStatus('error', pf.reason);
      diag.setGateway('wait', `${fmt(pf.waitMs)} 뒤 자동으로 다시 검사해요`);
      diag.print(`접속 전 자가진단 — ${fmt(pf.waitMs)} 뒤 재검사`);
      await sleepUntil(pf.waitMs);
      continue;
    }
    if (pf.contentIntent === false && withContent) {
      withContent = false;
      console.warn('[bot] ⚠️ MESSAGE CONTENT INTENT 가 꺼져 있어서 슬래시 명령 전용으로 접속해요 ("@친구 피파전쟁" 텍스트 명령은 꺼짐)');
    }
    diag.print('접속 전 자가진단 — 통과, 디스코드 접속 시작');

    // 2) 접속
    for (;;) {
      const client = createClient(withContent);
      runtime.client = client;
      const detach = diag.loginStart(client);
      const stopWatch = watchStall(client);
      setStatus(round === 1 ? 'starting' : 'reconnecting', '디스코드 게이트웨이 접속 중…');
      const r = await client.login(cfg.TOKEN).then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error }),
      );
      stopWatch();
      detach();
      if (r.ok) return; // 나머지는 ClientReady 에서
      runtime.client = null;
      await destroySafe(client);
      const v = diag.loginFailed(r);
      if (v.action === 'fallback' && withContent) {
        withContent = false;
        diag.print('접속 실패 진단 — 텍스트 명령 끄고 다시 접속');
        continue;
      }
      if (v.action === 'stop') {
        setStatus('error', v.title);
        diag.print('접속 실패 진단 — 접속 중단');
        return;
      }
      const wait = v.waitMs || 30000;
      setStatus('error', v.title);
      diag.print(`접속 실패 진단 — ${fmt(wait)} 뒤 재검사`);
      await sleepUntil(wait);
      break; // → 접속 전 검사부터 다시
    }
  }
}

// ───────── 종료 시 저장 (Render 재배포/재시작 = SIGTERM) ─────────
let stopping = false;
async function shutdown(sig, code = 0) {
  if (stopping) return;
  stopping = true;
  console.log(`[bot] ${sig} 수신 → 저장 후 종료`);
  await Promise.race([store.flushAll(), new Promise((r) => setTimeout(r, 8000))]).catch(() => {});
  await runtime.client?.destroy().catch(() => {});
  process.exit(code);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => errors.record(err, '처리 안 된 비동기 오류'));
process.on('uncaughtException', (err) => {
  errors.record(err, '처리 안 된 오류 (봇 재시작)');
  console.error(err);
  shutdown('uncaughtException', 1);
});

start().catch((err) => {
  errors.record(err, '시작 과정');
  setStatus('error', '시작 중 오류 — /diag 확인');
  diag.print('시작 오류');
});
