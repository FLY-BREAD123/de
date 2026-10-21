'use strict';
// 📖 오류 코드 사전 — 디스코드/네트워크 오류를 "무슨 문제 + 어떻게 고치는지" 한국어로 바꿔줌

const PORTAL = 'https://discord.com/developers/applications';
const STATUS = 'https://discordstatus.com';

const RESET_TOKEN = [
  `Developer Portal(${PORTAL}) → 내 봇 → Bot 탭 → Reset Token → Copy`,
  'Render → 서비스 → Environment → DISCORD_TOKEN 값 교체 (따옴표 없이) → Save Changes',
  '토큰을 깃허브에 올리면 디스코드가 자동으로 무효화해요. 코드에 넣지 말고 Render 환경변수에만 넣기',
];

const MESSAGE_CONTENT = [
  `Developer Portal(${PORTAL}) → 내 봇 → Bot 탭 → Privileged Gateway Intents`,
  'MESSAGE CONTENT INTENT 켜기 → Save Changes',
  'Render → Manual Deploy → Deploy latest commit (재시작)',
];

// 게이트웨이(웹소켓) 종료 코드
const CLOSE = {
  1000: ['정상 종료 (1000)', []],
  1001: ['디스코드가 연결을 옮김 (1001)', ['자동으로 다시 붙어요. 신경 안 써도 됨']],
  1006: ['연결이 갑자기 끊김 (1006)', ['네트워크가 잠깐 불안정했어요. 자동으로 다시 붙어요']],
  4000: ['디스코드 쪽 알 수 없는 오류 (4000)', ['자동으로 다시 붙어요', `계속되면 디스코드 장애 확인: ${STATUS}`]],
  4001: ['잘못된 명령 코드 (4001)', ['자동으로 다시 붙어요. 계속되면 로그 캡처해서 보내줘']],
  4002: ['잘못된 데이터 형식 (4002)', ['자동으로 다시 붙어요. 계속되면 로그 캡처해서 보내줘']],
  4003: ['로그인 전에 요청을 보냄 (4003)', ['자동으로 다시 붙어요']],
  4004: ['토큰 인증 실패 (4004)', RESET_TOKEN],
  4005: ['로그인 정보를 두 번 보냄 (4005)', ['자동으로 다시 붙어요']],
  4007: ['세션 번호 오류 (4007)', ['자동으로 다시 붙어요']],
  4008: ['게이트웨이에 너무 빨리 보냄 (4008)', ['잠깐 뒤 자동으로 다시 붙어요']],
  4009: ['세션 시간 초과 (4009)', ['자동으로 다시 붙어요']],
  4010: ['잘못된 샤드 번호 (4010)', ['코드 문제예요. 로그 캡처해서 보내줘']],
  4011: ['샤딩 필요 (4011)', ['봇이 서버 2,500개 넘게 들어가야 생기는 문제라 여기선 거의 없음']],
  4012: ['잘못된 API 버전 (4012)', ['discord.js 를 최신 14 버전으로: package.json 그대로 두고 재배포']],
  4013: ['잘못된 인텐트 값 (4013)', ['코드 문제예요. 로그 캡처해서 보내줘']],
  4014: ['허용 안 된 인텐트를 요청함 (4014)', MESSAGE_CONTENT],
};

// REST API 오류 코드 (DiscordAPIError.code)
const API = {
  0: ['디스코드 일반 오류', []],
  10003: ['채널이 없어요 — 지워졌거나 봇이 못 봐요 (10003)', ['/피파설정 경보채널:#채널 로 다시 지정']],
  10004: ['서버를 찾을 수 없어요 (10004)', ['봇이 서버에서 추방됐는지 확인']],
  10008: ['메시지가 지워졌어요 (10008)', ['신경 안 써도 됨 — 경보 메시지를 누가 지운 경우']],
  10062: [
    '버튼/명령 응답 시간(3초) 초과 (10062)',
    ['서버가 막 깨어났거나 느려서 생겨요. 다시 누르면 됨', '자주 생기면 Render 무료 서버가 잠들었다 깬 것 — 셀프핑이 켜져 있는지 /diag 확인'],
  ],
  20028: ['메시지 전송 속도 제한 (20028)', ['잠깐 뒤 다시 시도']],
  30005: ['서버 역할 수 한도 (30005)', ['역할 정리']],
  40001: ['인증 안 된 요청 (40001)', RESET_TOKEN],
  40060: [
    '다른 봇이 먼저 응답함 (40060) — 같은 토큰으로 봇이 2개 켜져 있어요',
    ['예전 Render 서비스(Background Worker 등)나 내 PC에서 돌던 봇을 끄기', '토큰을 새로 발급하면 예전 봇은 전부 꺼져요'],
  ],
  50001: ['접근 권한 없음 (50001 Missing Access)', ['봇 역할에 그 채널 "채널 보기" 권한 주기', '/진단 으로 어떤 채널인지 확인']],
  50007: ['상대가 DM을 막아둠 (50007)', ['정상 — 경보 채널 버튼으로 응답하면 돼요']],
  50013: [
    '권한 부족 (50013 Missing Permissions)',
    ['서버 설정 → 역할 → 봇 역할 → 빠진 권한 켜기', '/진단 으로 빠진 권한 이름 확인'],
  ],
  50035: ['요청 형식 오류 (50035)', ['코드 문제예요. 로그 캡처해서 보내줘']],
  50083: ['보관된 스레드 (50083)', ['스레드 보관 해제']],
  160002: ['스레드에서 응답 불가 (160002)', ['일반 채널에서 사용']],
};

// 네트워크 오류 코드
const NET = {
  ENOTFOUND: ['디스코드 주소를 못 찾음 (DNS 실패)', ['Render 쪽 네트워크 문제일 수 있어요. 잠시 뒤 자동 재시도', '계속되면 Render → Manual Deploy → Deploy latest commit']],
  EAI_AGAIN: ['DNS 응답 지연', ['잠시 뒤 자동 재시도']],
  ECONNREFUSED: ['디스코드가 연결을 거부함', ['잠시 뒤 자동 재시도']],
  ECONNRESET: ['연결이 끊김', ['잠시 뒤 자동 재시도']],
  ETIMEDOUT: ['연결 시간 초과', ['잠시 뒤 자동 재시도', `계속되면 디스코드 장애 확인: ${STATUS}`]],
  UND_ERR_CONNECT_TIMEOUT: ['연결 시간 초과', ['잠시 뒤 자동 재시도']],
  UND_ERR_SOCKET: ['연결이 끊김', ['잠시 뒤 자동 재시도']],
  TimeoutError: ['응답 시간 초과', ['잠시 뒤 자동 재시도']],
  AbortError: ['응답 시간 초과', ['잠시 뒤 자동 재시도']],
};

function closeCode(code) {
  const hit = CLOSE[code];
  if (hit) return { code, title: hit[0], fix: hit[1] };
  return { code, title: `게이트웨이 연결 종료 (${code})`, fix: ['자동으로 다시 붙어요'] };
}

function netCode(err) {
  const code = err?.cause?.code || err?.code || err?.name;
  const hit = NET[code];
  return hit ? { code, title: hit[0], fix: hit[1] } : null;
}

/** 아무 오류나 → { code, title, fix[], raw } */
function explainError(err) {
  if (!err) return { code: null, title: '알 수 없는 오류', fix: [], raw: '' };
  const raw = String(err?.message || err).slice(0, 300);
  const name = err?.name || err?.constructor?.name || '';

  if (name.startsWith('RateLimitError')) {
    const sec = Math.ceil((err.retryAfter || err.timeToReset || 0) / 1000);
    const wait = sec > 90 ? `약 ${Math.round(sec / 60)}분` : `${sec}초`;
    return {
      code: 429,
      title: `디스코드가 접속 요청을 막았어요 (레이트리밋 ${err.route || ''}, ${wait} 대기 요구)`,
      fix:
        sec > 60
          ? [
              'Render 무료 서버는 다른 사람들 봇과 IP를 같이 써서, 그 IP가 디스코드에 잠깐 막힐 수 있어요 (내 코드·토큰 문제 아님)',
              '기다리면 자동으로 다시 검사해서 풀리는 즉시 접속해요',
              '빨리 풀려면: Render → Manual Deploy → Deploy latest commit',
              '계속 막히면: Render 에서 새 Web Service 를 Region = Singapore 로 만들기',
            ]
          : ['잠시 뒤 자동으로 다시 시도해요'],
      raw: raw || `RateLimitError ${err.route || ''} retryAfter=${err.retryAfter}ms`,
    };
  }
  if (err?.code === 'TokenInvalid' || /invalid token/i.test(raw) || err?.status === 401) {
    return { code: 401, title: '토큰이 틀렸거나 무효예요 (401)', fix: RESET_TOKEN, raw };
  }
  if (err?.code === 'DisallowedIntents' || /disallowed intents/i.test(raw)) {
    return { code: 4014, title: 'MESSAGE CONTENT INTENT 가 꺼져 있어요 (4014)', fix: MESSAGE_CONTENT, raw };
  }
  if (/Authentication failed/i.test(raw)) return { code: 4004, ...closeCode(4004), raw };
  if (/Not enough sessions remaining/i.test(raw)) {
    return {
      code: 'SESSION_LIMIT',
      title: '디스코드 하루 접속 한도(보통 1,000번)를 다 썼어요',
      fix: ['한도가 풀리면 자동으로 접속해요', '봇이 계속 재시작되면 한도가 빨리 닳아요 → 로그에서 재시작 원인 확인'],
      raw,
    };
  }
  if (typeof err?.code === 'number' && API[err.code]) {
    const [title, fix] = API[err.code];
    return { code: err.code, title, fix, raw };
  }
  const net = netCode(err);
  if (net) return { ...net, raw };
  if (/fetch failed/i.test(raw)) return { code: 'NET', title: '디스코드에 연결 못 함 (네트워크)', fix: ['잠시 뒤 자동 재시도'], raw };
  return { code: err?.code ?? null, title: raw || name || '알 수 없는 오류', fix: ['로그 캡처해서 보내줘'], raw };
}

module.exports = { PORTAL, STATUS, RESET_TOKEN, MESSAGE_CONTENT, closeCode, explainError };
