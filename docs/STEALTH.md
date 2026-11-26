# 스텔스 대조 보고서 — ttycord vs discordo 및 기타 클라이언트

작성 기준: 2026-11-13. 디스코드 **API** 호출 없이 소스 대조, 공개 에코
엔드포인트(`tls.peet.ws`, `httpbingo.org`, 로컬 TLS 서버) 실측, 그리고 인증이
필요 없는 공개 정적 자산(`discord.com/app`과 그 JS 번들) 열람만 사용했다.
사용자 계정으로 디스코드에 요청을 보내는 검증은 하지 않았다.

## 1. 범위와 방법

- 비교 대상: `ayn2op/discordo` (main, commit `97c7a78`), `Bios-Marcel/cordless`,
  `uowuo/abaddon`, `Vencord/Vencord`, `discord.py-self`.
- 대조 축: TLS ClientHello → HTTP 계층 → 클라이언트 신원(Super-Properties) →
  Gateway 프로토콜 → 동작(레이트/하트비트).
- 우리 쪽 실측: `spoof-proxy` 경유 요청을 `tls.peet.ws/api/all`로 보내
  ALPN, JA4, Akamai h2 지문, 서버가 본 h2 헤더 블록을 수집했다. Gateway는
  로컬 TLS 서버를 세워 업스트림이 받은 핸드셰이크를 그대로 덤프했다.

## 2. 기준 클라이언트

| 클라이언트 | 언어/스택 | TLS 지문 위장 | 비고 |
|---|---|---|---|
| **discordo** | Go, `bogdanfinn/tls-client` | 있음 (`Chrome_152`, 랜덤 확장 순서) | TUI 중 유일 |
| cordless | Go, 표준 `net/http` | 없음 (Go ClientHello) | 아카이브됨 |
| abaddon | C++, OpenSSL | 없음 | |
| discord.py-self | Python, aiohttp | 없음 | |
| Vencord/BetterDiscord | 공식 Electron 클라이언트 주입 | 완벽 (실제 클라이언트 그 자체) | 클라이언트 변조 탐지 대상 |
| **ttycord (ours)** | Node + Go 헬퍼 | 있음 (`Chrome_154`, REST h2 / Gateway h1) | |

## 3. 계층별 대조

### 3.1 TLS ClientHello

| 항목 | discordo | ours | 판정 |
|---|---|---|---|
| 프로필 | `profiles.Chrome_152` | `profiles.Chrome_154` | 다름 (지문 동일) |
| GREASE | 포함 | 포함 (실측 `TLS_GREASE (0x1a1a)`) | 동일 |
| 암호/확장 집합 | Chrome 152 | Chrome 154 | 동일 (JA4 동일) |
| 확장 순서 랜덤화 | `WithRandomTLSExtensionOrder()` | `WithRandomTLSExtensionOrder()` | 동일 |
| REST ALPN | `h2, http/1.1` | **`h2, http/1.1`** (실측) | 동일 |
| Gateway ALPN | `http/1.1` (`WithForceHttp1`) | `http/1.1` (`WithForceHttp1`) | 동일 |
| 인증서 검증 | 기본 검증 | 기본 검증 | 동일 |
| 쿠키 저장소 | `tls_client.NewCookieJar()` | `tls_client.NewCookieJar()` | 동일 |

실측값 (`tls.peet.ws/api/all`) — **실제 Chrome 154와 우리 프록시가 동일**:

```
http_version: h2
ja4:          t13d1517h2_8daaf6152771_cb7bf5808d99
alpn:         ["h2","http/1.1"]
akamai:       1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p
```

`h2`와 Akamai SETTINGS 지문(`HEADER_TABLE_SIZE=65536`, `ENABLE_PUSH=0`,
`INITIAL_WINDOW_SIZE=6291456`, `MAX_HEADER_LIST_SIZE=262144`, 연결 윈도우
`15663105`)은 `Chrome_154` 프로필에서 그대로 나온 값이다. 이 값은 헤드리스
Chrome 154로 같은 엔드포인트를 조회한 결과와 **문자 단위로 같다**. 초기
버전은 `GetTLSDialer()`를 썼기 때문에 ALPN이 `http/1.1`로 강제됐고, 그래서
REST를 `HttpClient.Do()` 경로로 옮겼다. Gateway는 WebSocket이라 h1이 정상이다.

### 3.2 HTTP 계층

| 항목 | discordo | ours | 판정 |
|---|---|---|---|
| HTTP 버전 (REST) | HTTP/2 | **HTTP/2** | 동일 |
| h2 pseudo-header 순서 | 프로필 순서 | `:method, :authority, :scheme, :path` | 동일 |
| 일반 헤더 순서 | 알파벳 정렬 | Chrome 네트워크 스택 순서 (`HeaderOrderKey`) | **ours 우위** (근사) |
| `Accept` | `*/*` | `*/*` | 동일 |
| `Accept-Encoding` | Go 기본값(`gzip`) | `gzip, deflate, br` (스푸핑 시 `+ zstd`) | **ours 우위** |
| `Accept-Language` | `en-US,en;q=0.9` | 사용자 로케일 (`ko-KR,...`) | 의도된 차이 |
| `Origin` | **항상** (GET 포함) | **GET/HEAD 제외** (Chrome 실측과 동일) | **ours 우위** |
| `Referer` | 있음 | 있음 | 동일 |
| `Priority` | `u=1, i` | `u=1, i` | 동일 |
| `Sec-Ch-Ua` | GREASE 브랜드 생성 | GREASE 브랜드 생성 (Chromium 알고리즘 이식) | 동일 |
| `Sec-Ch-Ua-Mobile/Platform` | `?0` / `"Windows"` | `?0` / `"Linux"` | 동일 (OS 차이) |
| `Sec-Fetch-*` | 3종 | 3종 | 동일 |
| `X-Debug-Options` | `bugReporterEnabled` | `bugReporterEnabled` | 동일 |
| `X-Discord-Locale` | `en-US` (유효) | `ko` (Discord 열거형으로 정규화) | 동일 |
| `X-Discord-Timezone` | 로컬 | 로컬 (`Asia/Seoul`) | 동일 |
| `X-Super-Properties` | base64(JSON) | base64(JSON) | 동일 |
| 쿠키 전송 | jar가 자동 처리 | jar가 자동 처리 (실측 `foo=bar` 재전송) | 동일 |

실측한 h2 HEADERS 블록 순서 (GET, `Origin` 없음):

```
:method, :authority, :scheme, :path,
sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform, authorization,
user-agent, accept, x-super-properties, x-discord-locale,
x-discord-timezone, x-debug-options, sec-fetch-site, sec-fetch-mode,
sec-fetch-dest, referer, accept-encoding, accept-language, priority
```

이 순서는 `spoof-proxy`의 `restHeaderOrder`가 `fhttp.HeaderOrderKey`로
강제한다. fhttp는 이 키가 있을 때만 순서를 따르고, 없으면 알파벳 정렬한다
(표준 `net/http`는 순서 지정 자체가 불가능). `Authorization`이
`user-agent`보다 앞에 오는 것은 Chrome이 `fetch()` 호출에서 실제로 보내는
순서이며, `discordo`는 이 지점을 맞추지 못한다.

한 가지 정직한 한계: 실제 Chrome의 앱 헤더(`authorization`, `x-*`) 순서는
내부 헤더 맵 병합 결과라 요청마다/버전마다 조금씩 달라진다. 우리가 맞춘
것은 **네트워크 스택이 정하는 상대 순서**(`sec-ch-ua*` → `user-agent` →
`accept` → `sec-fetch-*` → `referer` → `accept-encoding` →
`accept-language` → `priority` → `cookie`)이고, 앱 헤더는 그 사이에
플랫폼별로 고정 배치한 근사값이다. Discord가 h2 프레임 순서까지
비교하지 않는 한 문제되지 않는다.

`Accept-Encoding`은 프록시가 Chrome 값을 직접 넣고, 응답은 프록시에서
직접 푼다. Node 22의 undici 6.21.2가 gzip/deflate/br은 풀지만 **zstd는
풀지 못하기** 때문이다. 광고만 줄이면 지문이 어긋나므로, 광고는 Chrome과
같게 두고 Go 쪽에서 gzip/deflate/br/zstd를 모두 해제해 평문으로 넘긴다.
프록시가 없을 때는 undici가 풀 수 있는 `gzip, deflate, br`만 광고한다.

`Origin`은 Chrome 실측(헤드리스 Chrome 154, 로컬 서버)에서 **GET에는
없고 POST/PUT/PATCH/DELETE에만** 붙었다. `discordo`는 모든 요청에 붙이므로
GET에서 우리가 더 정확하다.

### 3.3 클라이언트 신원 (Super-Properties)

| 필드 | discordo | ours | 비고 |
|---|---|---|---|
| `os` / `os_version` | Windows / 10 | Linux / `""` | 의도된 차이 |
| `os_arch` / `app_arch` | 없음 | 없음 | **웹 신원에서는 원래 없음** |
| `device` / `device_model_name` | `""` / 없음 | `""` / `""` | 웹 클라이언트와 동일 |
| `browser` | `Chrome` | `Chrome` | 동일 |
| `browser_version` | `152.0.0.0` | `154.0.0.0` | 현재 Chrome과 일치 |
| `browser_user_agent` | Chrome/152 Windows | Chrome/154 Linux | **TLS와 일치** |
| `client_build_number` | 649389 (데스크톱) | **671535 (웹)** | **ours 우위** |
| `native_build_number` | 없음 | 없음 | **웹 신원에서는 원래 없음** |
| `system_locale` | `en-US` | `TTYCORD_LOCALE` (기본 `ko-KR`) | 의도된 차이 |
| `has_client_mods` | `false` | `false` | 동일 |
| `launch_signature` | 마스크 동일 | 마스크 동일 | 완전 동일 |
| `client_launch_id` | UUIDv4 | UUIDv4 | 동일 |
| `client_heartbeat_session_id` | UUIDv4 | UUIDv4 | 동일 |
| `client_app_state` | `focused` | `focused` | 동일 |

신원은 **Chrome 154 웹 클라이언트**로 통일했다. 초기 버전은 데스크톱
Electron 신원(`discord/0.0.124 Chrome/138.0.0.0 Electron/37.6.1`)을
썼는데, `tls-client`에 `Chrome_138` 프로필이 없어 TLS(152)와 UA(138)가
어긋나는 구조적 모순이 있었다. 지금은 UA, `Sec-Ch-Ua`, Super-Properties의
`browser`/`browser_version`, TLS ClientHello가 모두 Chrome 154로 일치한다.
154는 대상 머신에 설치된 현재 안정 버전이고, 실제 Chrome 154와 우리
프록시의 JA4/Akamai 지문이 동일함을 확인했다.

필드 구성 자체도 실제 Discord 웹 번들(`discord.com/app`, `BUILD_NUMBER`
671535)의 `getSuperProperties` 코드와 대조했다. 그 코드에서
`os_arch`/`app_arch`/`native_build_number`/`client_version`/`os_sdk_version`은
`window.DiscordNative`가 존재할 때, 즉 **Electron 데스크톱에서만** 채워지고
브라우저에서는 생략된다. 반대로 `device_model_name`은 웹에서도 항상 포함되며
값은 `""`다. `client_build_number`는 `GLOBAL_ENV.BUILD_NUMBER`(웹 빌드)에서
오므로 데스크톱 셸 빌드(649389)와 다르다. `os_version`은 브라우저의 UA
파서가 뽑은 값이라 Linux UA에서는 빈 문자열이다(커널 버전이 아니다).

이 대조 덕분에 "없는 게 격차"라고 잘못 적었던 항목 두 개가 실제로는
**웹 신원에서 올바른 상태**임이 확인됐다. 반대로 `client_build_number`와
`device_model_name`은 실제로 틀려 있었고 이번에 고쳤다.

`Sec-Ch-Ua`는 Chromium `user_agent_utils.cc`의 GREASE 알고리즘을 그대로
이식했다. major 154의 출력은
`"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"`이고,
브랜드 순서와 GREASE 문자/버전이 버전에서 결정론적으로 나온다. 이 값은
헤드리스 Chrome 154가 실제로 보낸 값과 같다.

로케일은 `LOCALE` 하나에서 파생한다. `system_locale`과 `Accept-Language`는
BCP-47 태그(`ko-KR`)를 쓰고, `X-Discord-Locale`은 Discord 자체 열거형으로
정규화한다(한국어는 `ko-KR`이 아니라 `ko`). 초기 버전은 `X-Discord-Locale`에
`ko-KR`을 그대로 보냈는데, 이는 Discord가 정의하지 않은 값이다.
`TTYCORD_LOCALE`로 바꿀 수 있다.

### 3.4 Gateway

| 항목 | discordo | ours | 판정 |
|---|---|---|---|
| URL/버전 | `?v=9&encoding=json` | `?v=9&encoding=json` | 동일 |
| 핸드셰이크 헤더 순서 | gorilla 기본 | **Chrome 순서** (`fhttp.HeaderOrderKey`) | ours 우위 |
| `Origin` | `https://discord.com` | `https://discord.com` | 동일 |
| `User-Agent` | Chrome/152 Windows | Chrome/154 Linux | 동일 (OS 차이) |
| `Sec-Fetch-Mode: websocket` | 있음 | 있음 | 동일 |
| `Accept` (핸드셰이크) | 없음 | 없음 (프록시가 제거) | 동일 |
| `capabilities` | 8701 | **8701** | 동일 |
| `compress` | `false` (미설정) | `false` | 동일 |
| `large_threshold` | 없음(0, omitempty) | 없음 | 동일 |
| `presence` | 없음 | `{status:'online',...}` | ours가 실제 웹 클라이언트에 가까움 |
| permessage-deflate | `EnableCompression = true` | 헤더는 협상 (Node WS) | 부분 동일 |
| 하트비트 지터 | arikawa 구현 | 랜덤 초기 지연 | 동등 |
| RESUME | `resume_gateway_url` 사용 | **`resume_gateway_url` 사용** (프록시 경유) | 동일 |
| 치명 코드 | 4004/4010~4014 | 동일 | 동일 |

업스트림이 실제로 받은 핸드셰이크 (로컬 TLS 서버 실측):

```
GET /?v=9&encoding=json HTTP/1.1
Host: localhost:PORT
Connection: Upgrade
Pragma: no-cache
Cache-Control: no-cache
User-Agent: Mozilla/5.0 (X11; Linux x86_64) ... Chrome/154.0.0.0 Safari/537.36
Upgrade: websocket
Origin: https://discord.com
Sec-Fetch-Mode: websocket
Sec-Websocket-Version: 13
Accept-Encoding: gzip, deflate, br, zstd
Accept-Language: ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7
Sec-Websocket-Key: ...
Sec-Websocket-Extensions: permessage-deflate; client_max_window_bits
```

RESUME은 프록시를 써도 정상 동작한다. READY가 샤드별 호스트
(`gateway-us-east1-b.discord.gg`)를 알려주면, Node가 그 URL을 로컬 프록시
주소로 바꾸고 실제 호스트를 `X-Spoof-Host`로 넘긴다. 프록시는 이 값을
`discord.gg`/`discord.com` 및 설정된 대상으로만 허용하고 업스트림으로는
전달하지 않는다. 따라서 프록시가 오픈 프록시가 되지 않으면서 RESUME의
최적화도 유지된다. (이전 판에서는 프록시 사용 시 URL을 고정해 이 최적화를
포기했다.)

`capabilities` 8701 = `LazyUserNotes(1) | VersionedReadStates(4) |
VersionedUserGuildSettings(8) | DedupeUserObjects(16) |
PrioritizedReadyPayload(32) | MultipleGuildExperimentPopulations(64) |
NonChannelReadStates(128) | AuthTokenRefresh(256) |
DebounceMessageReactions(8192)`. 페이로드 형식을 바꾸는 비트는 파서에
반영했다: 버전드 `read_state`는 `entries` 배열에서 읽고, 배열 형식도
받아들이며, `DedupeUserObjects`의 사용자 스텁은 READY의 `users` 배열로
수화한다(`src/live.js`).

### 3.5 동작

| 항목 | discordo | ours |
|---|---|---|
| 레이트 리밋 | arikawa 내장 | 라우트 버킷 + 전역 + 55ms 간격 |
| 429/5xx 재시도 | 라이브러리 위임 | 지수 백오프 직접 구현 |
| 타이핑 스로틀 | UI 계층 | 8초 |
| 읽음 처리 | arikawa `Ack` | `{token:null}` POST, 2초 스로틀 |
| 재연결 | 4+2·try초 | 1~30초 지수 백오프 + 지터 |

동작 계층은 우리 쪽이 discordo보다 명시적이고, 기능적으로 동등 이상이다.

## 4. 다른 클라이언트와의 비교

- **Vencord/BetterDiscord**: 공식 Electron 클라이언트에 주입하므로 TLS·HTTP·
  신원이 100% 실제와 같다. 대신 클라이언트 변조 자체가 탐지 대상이고,
  `has_client_mods`를 패치해야 한다. 우리 방식과는 접근이 다르다.
- **cordless / abaddon / discord.py-self**: TLS 위장이 아예 없다. Go/OpenSSL/
  Python의 ClientHello가 그대로 나가므로, TLS 지문만 보면 우리가 앞선다.
- **discordo**: TUI 중 유일한 TLS 위장 구현이며, 우리의 직접적인 비교
  대상이다. TLS 프로필과 Gateway 방식은 같고, REST 헤더 순서·쿠키·신원
  일관성에서는 우리 쪽이 더 촘촘하다.

## 5. 잔여 격차 (탐지 가능성 순)

| # | 격차 | 탐지 가능성 | 수정 비용 | 비고 |
|---|---|---|---|---|
| 1 | permessage-deflate 실제 압축 처리 | 낮음 | 높음 | Node 내장 WS 제약, 헤더는 협상됨 |
| 2 | HTTP/3 미사용 | 낮음 | 높음 | Chrome은 alt-svc로 h3 전환 가능 |
| 3 | `client_build_number` 하드코딩 | 매우 낮음 | 낮음 | 웹 빌드가 올라가면 낡음 (환경 변수로 교체 가능) |
| 4 | 앱 헤더의 절대 순서는 근사 | 매우 낮음 | — | Chrome 내부 병합 순서라 고정 불가 |
| 5 | JS 실행 환경 신호 부재 | 해당 없음 | — | REST/Gateway는 브라우저 API를 수집하지 않음 |

이전 판에 있던 `os_arch`/`app_arch`/`native_build_number`는 격차가 아니다.
Discord 웹 번들을 확인한 결과 그 필드들은 Electron 데스크톱 전용이고,
브라우저는 보내지 않는다. 우리는 Chrome 웹 신원이므로 없는 것이 맞다.
스푸핑 시 Gateway URL 고정도 해결했다(§3.4).

1번은 Node `WebSocket`이 `permessage-deflate`를 협상 헤더로 보내지만
실제 프레임 압축 해제는 런타임 의존이라는 점이다. 디스코드 게이트웨이는
`compress: false`를 보내므로 실사용 경로에서는 압축 프레임이 오지 않는다.
2번은 Chrome이 Discord에 h3로 붙을 수 있다는 정도의 차이이고, REST h2
지문이 Chrome과 같으므로 단독으로 계정을 특정하지는 못한다.
4번은 Chrome이 앱 헤더를 내부 해시 맵에서 병합해 내보내므로, 어떤 고정
순서도 근사일 수밖에 없다는 뜻이다. 네트워크 스택 헤더의 상대 순서는
맞췄다. 3번은 `DISCORD_CLIENT_BUILD_NUMBER`로 즉시 교체할 수 있다.

## 5.1 레이트 리밋 대응 비교

은닉 품질과 별개로, 사용자 계정에 가장 현실적인 위험은 **429 누적**입니다.
키 입력이 곧 요청이 되는 TUI에서는 특히 그렇습니다.

| 항목 | discordo (arikawa) | ours |
|---|---|---|
| 버킷 추적 | `X-RateLimit-Bucket/Remaining/Reset` | 동일 |
| 전역 한도 | `global` 원자값 | `globalUntil` |
| 요청 간 여유 | `ExtraDelay = 250ms` | 큐 직렬화 + 120ms 간격 |
| 429/5xx | 재시도 루프 | `retry_after + 75ms`, 최대 3회 |
| 타이핑 | 10초, 설정으로 on/off | 8초, `--no-typing`/설정 |
| 재로드 연타 | 해당 바인딩 없음 | 1.5초 쿨다운 |
| 전송 연타 | 초안을 즉시 비움(중복만 방지) | 5초/4회 슬라이딩 윈도우 |
| 채널 훑기 | 커서 이동 시 즉시 조회 | 120ms 디바운스 + 세대 카운터 |

`ExtraDelay`가 arikawa 쪽이 더 보수적이지만, 우리는 애초에 요청을 하나씩만
내보내고 120ms를 띄우므로 실효 속도는 비슷합니다. 반면 **재로드·전송·채널
훑기**는 discordo에 없는 가드로, 429를 맞기 전에 막습니다.

## 6. 수정 이력 (버그 포함)

해결한 항목:

1. REST를 `HttpClient.Do()` 경로로 전환 → h2 ALPN, SETTINGS, pseudo-header
   순서, 연결 윈도우를 Chrome과 일치.
2. `WithRandomTLSExtensionOrder()` 추가 → 확장 순서 고정 해제.
3. `WithCookieJar(NewCookieJar())` 추가 → `__dcfduid`/`__sdcfduid`/`__cfruid`
   왕복. 실측으로 `foo=bar` 재전송 확인.
4. `Sec-Ch-Ua`(GREASE), `Sec-Ch-Ua-Mobile/Platform`, `Priority` 추가.
5. Chrome 헤더 순서를 `HeaderOrderKey`로 강제 (REST h2, Gateway h1 모두).
6. 신원을 Chrome 154 웹으로 통일(`Chrome_154` 프로필). `browser_version`/UA/TLS
   불일치 제거.
7. Gateway 핸드셰이크에 `Origin`, `User-Agent`, `Sec-Fetch-Mode`,
   `Accept-Encoding`, `Accept-Language` 주입 및 Node의 `Accept: */*` 제거.
8. `capabilities`를 8701로 올리고, 버전드 read state와 deduped user
   수화를 파서에 반영.
9. `device: ""` 추가, 로케일 단일화(`LOCALE`, `TTYCORD_LOCALE`),
   `X-Discord-Locale`을 Discord 열거형으로 정규화(`ko-KR` → `ko`).
10. 프록시에서 `Accept-Encoding: gzip, deflate, br, zstd`를 광고하고
    gzip/deflate/br/zstd를 직접 해제 (undici zstd 미지원 대응). 프록시가
    없을 때는 undici가 풀 수 있는 `gzip, deflate, br`을 광고한다.
11. 실제 Chrome 154(로컬 헤드리스)와 직접 대조: JA4/Akamai 지문 동일,
    `Sec-Ch-Ua` 값 동일, GET에 `Origin`이 없음을 확인해 GET/HEAD에서 제거.
12. `--spoof`를 기본값으로 전환. `--no-spoof`/`TTYCORD_SPOOF=0`으로 끄며,
    바이너리가 없으면 경고 후 직접 연결로 폴백한다(명시적 `--spoof`는 오류).
13. Discord 웹 번들과 Super-Properties 대조: `client_build_number`를 웹 빌드
    (671535)로, `device_model_name: ""` 추가, `os_version`을 UA 파서 값으로
    (Linux는 `""`). 데스크톱 전용 필드는 보내지 않는 것이 맞음을 확인.
14. 프록시 경유 RESUME 지원(`X-Spoof-Host`, Discord 도메인 화이트리스트).
15. 키 입력 폭주 방지: REST 최소 간격 55→120ms, `ctrl+r` 1.5초 쿨다운,
    채널 이동 120ms 디바운스 + 세대 카운터, 전송 5초/4회 슬라이딩 윈도우,
    `--no-typing`/설정으로 타이핑 표시 끄기.

과정에서 발견해 고친 버그:

- **`--spoof` 경로 누락**: `connect()`가 `baseUrl: spoof.restUrl`을 넘겨
  실제 디스코드에서 `/users/@me`가 404가 될 상태였다. `${spoof.restUrl}/api/v9`로
  수정하고, 가짜 프록시로 `/api/v9/users/@me` 수신을 확인했다.
- **keep-alive 불안정**: h1 경로에서 `tls.peet.ws` 상대 `UND_ERR_SOCKET`이
  간헐 발생했다. h2 경로 전환 후 연속 12회 모두 성공.
- **중복 `accept-encoding`**: fhttp가 소문자 키를 검사하고 Go는
  canonical로 바꾸므로, `TransportOptions{DisableCompression: true}`가
  필요했다. 없으면 헤더가 두 번 나간다.
- **zstd 미해제**: undici가 zstd를 풀지 못해 501 에러 본문이 압축된 채
  JSON 파싱에 실패했다. 프록시 측 해제로 해결.
- **`X-Discord-Locale` 값 오류**: `ko-KR`은 Discord 열거형에 없는 값이다.
  `ko`로 정규화하고, `system_locale`/`Accept-Language`와의 관계를 분리했다.
- **GET의 `Origin`**: 실제 Chrome은 same-origin GET/HEAD에 `Origin`을 보내지
  않는다. 모든 요청에 붙이던 것을 POST/PUT/PATCH/DELETE로 제한했다.

## 7. 총평

- **TLS 계층(REST)**: Chrome 154와 JA4/ALPN/Akamai 지문까지 일치(실제 Chrome 154와 동일).
- **TLS 계층(Gateway)**: Chrome WebSocket과 사실상 동일. 상한에 근접.
- **HTTP 계층(REST)**: h2 + Chrome 헤더 순서 + 쿠키 jar. discordo보다 촘촘하다.
- **신원**: UA·Client Hints·Super-Properties·TLS가 모두 Chrome 154로 일관.
  필드 구성도 Discord 웹 번들과 대조해 웹 클라이언트와 같다.
- **Gateway 프로토콜**: `capabilities` 8701, 핸드셰이크 헤더까지 정렬,
  RESUME도 프록시 경유로 유지. 남은 차이는 permessage-deflate 실제 처리와
  HTTP/3 정도다.
- **기본값**: `--spoof`가 기본이라 위 계층이 별도 옵션 없이 적용된다.

초기 보고서의 "TLS는 따라잡았지만 HTTP와 신원 일관성에서 한 단계 뒤처진
상태"는 더 이상 사실이 아니다. 현재는 **TUI 계열 상한(discordo)과 동등
이상이고, 남은 격차는 실사용 경로에 영향을 주지 않는 항목**이다.

## 8. 재현 방법

디스코드 API를 호출하지 않고 아래처럼 확인할 수 있다.

```bash
# 0) 실제 Chrome과의 지문 대조 (설치된 Chrome 사용)
google-chrome --headless=new --no-sandbox --disable-gpu \
  --user-data-dir=/tmp/chrome-probe --virtual-time-budget=6000 \
  --dump-dom https://tls.peet.ws/api/all
# 결과의 tls.ja4, http2.akamai_fingerprint 를 프록시 결과와 비교

# 1) REST h2 + 헤더 순서 + JA4
spoof-proxy/bin/spoof-proxy -rest-target https://tls.peet.ws \
  -gateway-target https://tls.peet.ws &
# 출력된 rest URL로 /api/all 을 호출해 http_version, tls.ja4,
# http2.sent_frames[HEADERS].headers 를 확인

# 2) 쿠키 jar / 압축 해제
spoof-proxy/bin/spoof-proxy -rest-target https://httpbingo.org \
  -gateway-target https://httpbingo.org &
# /cookies/set?foo=bar → /cookies, /gzip, /headers

# 3) Gateway 핸드셰이크
# 로컬 TLS 서버(자체 서명 인증서)를 띄우고 프록시의 -gateway-target을
# wss://localhost:PORT로 지정한 뒤, 업스트림이 받은 요청 헤더를 덤프한다.
```

`npm test`는 75개 오프라인 테스트를 실행하며, 여기에 헤더 순서/신원
일관성/버전드 read state/deduped user 수화 검증이 포함된다.
