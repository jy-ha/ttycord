# 디스코드 터미널 클라이언트 분석 및 구현 보고서

작성일: 2026-11-12

## 1. 목표

리눅스 터미널에서 동작하는 최소 기능 디스코드 클라이언트를 만든다.

- 로그인 (로컬 디스코드 클라이언트의 토큰 재사용)
- 서버(길드) / 채널 / 다이렉트 메시지 목록
- 메시지 기록 읽기
- 텍스트 메시지 전송
- 실시간 메시지 수신
- 읽음 처리

공식 클라이언트를 실행하지 않고, 로컬에 설치된 파일과 실제 디스코드 서버 응답을
대조해 구현하는 것이 목표였다.

## 2. 분석 대상과 도구

### 2.1 로컬 디스코드 클라이언트

| 항목 | 값 |
| --- | --- |
| 배포 형태 | Flatpak `com.discordapp.Discord` |
| 버전 | `0.0.124` (stable) |
| 설치 경로 | `~/.local/share/flatpak/app/com.discordapp.Discord/current/active/files/discord` |
| 설정/데이터 | `~/.var/app/com.discordapp.Discord/config/discord` |
| Electron 셸 | `resources/app.asar` (1,209개 파일 추출) |
| 데스크톱 코어 | `0.0.124/modules/discord_desktop_core/core.asar` (2,441개 파일 추출) |

`app.asar`와 `core.asar`는 ASAR 헤더(JSON 디렉터리 + 오프셋)를 직접 파싱해
`/tmp/opencode/discord-asar/`에 추출했다. 추출 파일은 분석용으로만 사용했고
프로젝트에는 포함하지 않았다.

### 2.2 확인한 사실

- Electron 셸은 `mainScreen.js`에서 `URL_TO_LOAD = WEBAPP_ENDPOINT + WEBAPP_PATH`를
  로드한다. 즉 UI의 상당 부분은 로컬 asar가 아니라 원격 `https://discord.com/app`
  웹 앱이 담당한다.
- `core.asar`에는 창 관리, 업데이트, 알림, 트레이, 네이티브 모듈 등 데스크톱
  통합 코드가 들어 있다. REST/Gateway 프로토콜 구현은 원격 웹 앱 번들에 있다.
- 로컬 사용자 토큰은 Chromium `Local Storage/leveldb`에 저장되어 있었다.
  현재 토큰 형식은 `base64(user_id).base64(6 bytes).base64(27 bytes)` 형태이며,
  정규식 `[\w-]{20,}\.[\w-]{6}\.[\w-]{25,}`로 찾을 수 있다.
- `READY` payload에는 길드·DM·읽음 상태 목록이 포함되어 있었다.

### 2.3 참고한 공개 자료

- Discord 공식 API 문서 (`https://docs.discord.com/developers/`)
- Discord Userdoccers (`https://docs.discord.food/`) — 사용자 토큰 클라이언트가
  사용하는 비공식 필드/엔드포인트 확인
- `ayn2op/discordo` (Go, GPL-3.0) — 슈퍼 프로퍼티, 게이트웨이 처리, TUI 기능 구성
  참고. 코드는 복사하지 않았다.
- `Bios-Marcel/cordless` (Go, 아카이브됨) — 과거 TUI 구조 참고.
- `kakao-linux` (MIT, 같은 작성자) — 셀 그리드 렌더러/입력 파서/TUI 구조 재사용.

## 3. 프로토콜 정리

### 3.1 REST API v9

Base URL은 `https://discord.com/api/v9`이다. 공식 **Chrome 웹 클라이언트**와
같은 신원으로 다음 헤더를 보낸다. 프록시(기본 켜짐)가 이 헤더들을
Chrome의 h2 순서 그대로 업스트림에 전달한다.

- `Authorization: <user token>` (Bot 토큰이면 `Bot <token>`)
- `User-Agent: Mozilla/5.0 ... Chrome/154.0.0.0 Safari/537.36`
- `Sec-Ch-Ua`: Chromium GREASE 알고리즘으로 생성한 브랜드 목록,
  `Sec-Ch-Ua-Mobile: ?0`, `Sec-Ch-Ua-Platform: "<OS>"`
- `X-Super-Properties`: base64(JSON) — OS, `browser: "Chrome"`,
  `browser_version: "154.0.0.0"`, `device: ""`, 빌드 번호, 로케일,
  launch signature 등
- `X-Discord-Locale`(Discord 열거형, 예: `ko`), `X-Discord-Timezone`,
  `Origin`, `Referer`, `Sec-Fetch-*`, `Priority: u=1, i`
- `Accept-Encoding: gzip, deflate, br` (프록시 사용 시 `+ zstd`)
- 쿠키 jar(`__dcfduid` 등)는 프록시 사용 시 `tls-client`가 자동 처리

구현한 엔드포인트:

| 용도 | 메서드/경로 |
| --- | --- |
| 내 정보 | `GET /users/@me` |
| 길드 목록 | `GET /users/@me/guilds` |
| 길드 채널 | `GET /guilds/{guild_id}/channels` |
| DM 목록 | `GET /users/@me/channels` |
| 채널 정보 | `GET /channels/{channel_id}` |
| 메시지 기록 | `GET /channels/{channel_id}/messages?limit=50&before=...` |
| 메시지 전송 | `POST /channels/{channel_id}/messages` |
| 입력 중 | `POST /channels/{channel_id}/typing` |
| 읽음 처리 | `POST /channels/{channel_id}/messages/{message_id}/ack` |

`429` 응답은 `retry_after`/`Retry-After`를 존중하고, 라우트별 버킷
(`X-RateLimit-Bucket`)과 전역 제한을 추적한다. `5xx`는 지수 백오프로 재시도한다.

### 3.2 Gateway

- URL: `wss://gateway.discord.gg/?v=9&encoding=json`
- `op 10 HELLO` → `heartbeat_interval` 수신
- `op 2 IDENTIFY`:

```json
{
  "op": 2,
  "d": {
    "token": "...",
    "capabilities": 8701,
    "properties": {
      "os": "Linux",
      "browser": "Chrome",
      "browser_version": "154.0.0.0",
      "device": "",
      "device_model_name": "",
      "os_version": "",
      "client_build_number": 671535,
      "release_channel": "stable",
      "system_locale": "ko-KR",
      "client_launch_id": "...",
      "launch_signature": "...",
      "is_fast_connect": true
    },
    "compress": false,
    "presence": { "status": "online", "since": 0, "activities": [], "afk": false }
  }
}
```

`capabilities` 8701은 현재 공식 클라이언트가 보내는 조합이다. 그중 페이로드
형식을 바꾸는 비트는 파서에 반영했다. `VersionedReadStates`는 `read_state`를
`{ entries: [...] }`로 보내므로 `entries`에서 읽고(배열 형식도 허용),
`DedupeUserObjects`는 READY의 `users` 배열에 있는 사용자만 남기고 다른
객체에서는 `id`만 보내므로 DM 수신자/멤버를 그 배열로 수화한다.

- `op 1` 하트비트(현재 sequence 전송), `op 11` ACK
- 하트비트 후 10초 안에 ACK가 오지 않으면 좀비 연결로 판단하고 재연결한다.
  다음 41초 하트비트까지 기다리지 않으므로 절전 복귀 후 멈춘 느낌이 짧다.
- `op 7 RECONNECT`: 세션이 있으면 `op 6 RESUME`
- `op 9 INVALID_SESSION`: `d === true`이고 세션이 있으면 1~5초 대기 후 RESUME,
  아니면 세션/sequence를 버리고 새 IDENTIFY
- `4004`, `4010`~`4014` close code는 치명적 오류로 재시도하지 않음

절전/재개는 앱의 1초 시계가 `Date.now()` 점프(10초 이상)를 감지해 처리한다.
게이트웨이는 열린 것처럼 보이는 소켓에 즉시 하트비트를 보내고, 미결 하트비트가
있거나 ACK가 없으면 백오프 없이 재연결한다. `SIGCONT`도 같은 경로다. 1.5초 뒤
화면 맨 아래의 보이는 채널만 REST에서 최신 50개로 다시 불러오며, 위로 스크롤한
창은 유지한다. 강제 재로드가 실패하면 기존 메시지를 지우지 않는다. 절전 복귀
직후에는 네트워크가 아직 올라오지 않았거나 프록시가 죽은 keep-alive 연결을
재사용해 `502 upstream error`가 날 수 있으므로, 2·5·10·20초 간격으로 조용히
재시도하고 마지막에만 `ctrl+r` 안내를 띄운다. Go 프록시 역시 1초 ticker의
벽시계 점프를 감지해 `CloseIdleConnections()`로 풀을 비운다.

### 3.3 읽음 처리

공식 문서에 사용자 토큰용 ack API는 없지만, 공식 클라이언트와 공개 구현들이
`POST /channels/{channel_id}/messages/{message_id}/ack`에 `{ "token": null }`을
보낸다. 이 프로젝트도 같은 요청을 사용한다. 실패는 무시하고 UI 상태만 갱신한다.

## 4. 구현 구조

```
bin/ttycord.js          CLI 실행 파일
src/cli.js                  명령 파서/출력
src/client.js               REST 래퍼, 토큰 해석, 캐시
src/live.js                 Gateway 이벤트 → TUI 이벤트
src/store.js                토큰 설정 저장 (0600)
src/token-source.js         leveldb 토큰 탐색/검증
src/spoof.js                TLS 지문 프록시 프로세스 관리 (기본 켜짐)
src/protocol/properties.js  UA/슈퍼 프로퍼티/launch signature
src/protocol/rest.js        REST + rate limit
src/protocol/gateway.js     Gateway + heartbeat/resume
spoof-proxy/main.go         Go TLS 지문 리버스 프록시 (기본 켜짐)
src/tui/term.js             셀 그리드 렌더러 (kakao-linux에서 재사용)
src/tui/input.js            키/마우스/붙여넣기 파서 (재사용)
src/tui/clipboard.js        드래그 선택 → 클립보드 (GTK/OSC 52)
src/tui/attach.js           드래그 경로/URI → 첨부 파일 파싱·검증
src/tui/composer.js         여러 줄 입력창의 시각 줄/커서 매핑
src/tui/draw.js             텍스트/프레임/줄바꿈 (재사용)
src/tui/layer.js            오프스크린 행 레이어 (재사용)
src/tui/theme.js            디스코드 다크 팔레트
src/tui/layout.js           레일/사이드바/메시지/입력창 지오메트리
src/tui/model.js            길드/채널/메시지 표현 모델
src/tui/pane.js             메시지 그룹화, 마크다운 일부, 입력창
src/tui/views.js            상단바/레일/사이드바/상태바/도움말/토스트
src/tui/app.js              상태, 입력 처리, 실시간 연결
src/tui/index.js            터미널 수명주기, --dump
```

### 4.1 TUI 레이아웃

- 왼쪽: 길드 레일 (DM 홈 + 서버 이름 목록, 15–20칸, 좁으면 숨김)
- 가운데: 채널 사이드바 (카테고리별 텍스트 채널, 읽지 않음/멘션 표시)
- 오른쪽: 채널 헤더 + 메시지 로그 + 입력 중 표시 + 입력창 (분할 시 2×2 그리드)
- 하단: 연결 상태/포커스/키 힌트

메시지는 같은 작성자가 5분 이내에 연속으로 보내면 묶어서 표시하고, 날짜 구분선과
"새 메시지" 구분선을 넣는다. 멘션, 답장, 첨부파일, 임베드, 스티커, 수정됨 표시를
간단히 렌더링한다.

입력창은 여러 줄을 지원한다. `composer.js`가 초안을 시각 줄로 나누고(논리적 `\n`과
폭에 따른 소프트 랩), 그래핌 커서 인덱스를 `(row, column)`으로 매핑한다. 입력창은
최대 6줄까지 늘어나며 그 이상은 커서를 따라 내부 스크롤한다. `enter`는 전송,
`ctrl+enter`/`alt+enter`/`shift+enter`/`ctrl+j`는 줄바꿈이다. 터미널이
`modifyOtherKeys`(`CSI 27;mod;code~`)나 kitty keyboard protocol(`CSI code;mod u`)을
지원하면 `ctrl+enter`가 구분되어 도착하고, VTE 0.68처럼 지원하지 않는 터미널에서는
`alt+enter`/`ctrl+j`를 쓴다. `↑`/`↓`는 먼저 시각 줄 사이를 이동하고, 경계에서만
전송 기록으로 넘어간다. 여러 줄 붙여넣기는 CRLF를 `\n`으로 정규화해 줄바꿈을
보존한다. 드롭 판별은 `looksLikeFileDrop()`이 맡는다: 붙여넣기의 모든 줄이 경로
토큰으로만 이루어져야 하고, 여러 줄이면 최소 한 개가 실제 파일로 존재해야 한다.
따라서 경로가 섞인 로그/스택트레이스는 첨부로 오인되지 않고 텍스트로 들어간다.

`m`을 누르거나 메시지를 클릭하면 `focus`가 `messages`로 바뀌고, 그 줄에
커서 밴드와 `▌` 거터가 그려진다. 클릭한 경우에는 메시지 옆에 액션 메뉴가 뜬다:
반응, 답장, 수정, 삭제, 링크 복사(내 메시지에만 수정/삭제). 항목을 마우스로
누르면 해당 동작이 실행되고, 바깥 클릭이나 `esc`로 닫힌다. 삭제는 메뉴에서도
두 번 눌러 확인한다. `r`은 반응 바를 열어 `1`-`8` 빠른 선택 또는
`:fire:`/`🔥` 입력을 받고, `R`은 답장(`message_reference`), `e`는 내 메시지 수정,
`d`는 두 번 눌러 삭제, `y`는 `discord.com/channels/...` 링크 복사다. 반응은 서버
응답을 기다리지 않고 로컬에서 먼저 갱신하고 실패 시 되돌린다. `MESSAGE_REACTION_*`
게이트웨이 이벤트도 같은 `applyReactionLocal()`을 거치므로 내 반응과 남의 반응이
같은 `{ count, me }` 모양을 유지한다. 답장/수정 중에는 입력창 위에 한 줄 배너가
생기고 `computeLayout({ banner })`이 그 높이를 예약한다. `esc`는 배너를 먼저
취소하고, 그 다음에야 입력창을 떠난다.

펜스 코드블록은 `highlight.js`가 ```/~~~ 언어 태그를 찾아 언어별 토큰으로 나눈다.
문자열·주석·숫자·키워드·함수 호출·구두점·diff 증감 줄에 색을 입히고, 긴 줄은
토큰 경계를 유지한 채 창 폭에 맞춰 접는다. 블록 주석은 줄을 넘어 상태가 유지된다.
언어를 모르면 색 없이 원문만 그린다.

새 메시지가 보이지 않거나 스크롤이 위쪽이면 Discord의 채널별 알림 설정을 따라
소리를 낸다. READY의 `user_guild_settings`를 길드/채널 단위로 파싱해
`message_notifications`(0 전체, 1 멘션, 2 없음, 3 상속)와 음소거를 적용하고,
`USER_GUILD_SETTINGS_UPDATE`로 갱신한다. 설정이 없을 때만 `TTYCORD_BELL`
정책(`mention` 기본, `all`, `off`)을 사용한다. 소리는 `sound.js`가 `paplay` 등
재생기를 detached로 실행하며, 재생기가 없으면 터미널 벨로 대체한다
(`TTYCORD_SOUND`, `TTYCORD_SOUND_CMD`). 1.5초 쿨다운이 있고, 터미널 타이틀에는
멘션 수(`ttycord !1`)를, 멘션 메시지에는 거터 `!`를 표시한다.
타이틀/벨은 `App.out`이 TTY일 때만 OSC/`\x07`을 쓰므로 `--dump`나 파이프 출력에는
이스케이프가 섞이지 않는다.

#### 분할 보기

`s`로 분할 모드를 켜면 `computeLayout()`이 채팅 영역을 `panes` 개수에 맞춰
배치한다. 1개는 전체 화면, 2개는 좌우 2열, 3개는 위쪽 2열 + 아래쪽 1열(전체 폭),
4개는 2×2 그리드다. 각 창은 독립적인 `{ chat, header, messages, typing, composer }`
사각형을 가지며, 행/열 사이에는 1칸 구분선을 둔다. 구분선 위치와 교차점(`┼`)은
`computeLayout()`이 `bands`/`dividers`로 계산해 뷰가 좌표를 추측하지 않게 한다.
터미널이 너무 짧아 두 행을 온전히 그릴 수 없으면 한 행으로 폴백한다. 최대
4개(`MAX_PANES`)까지 허용하며, 기존 단일 채널 코드와의 호환을 위해 최상위
`chat`/`messages`/`composer` 등은 포커스된 창의 사각형을 가리킨다. 입력창 높이는
모든 창의 초안 중 가장 긴 줄 수와 첨부 행 수를 사용해 기준선이 어긋나지 않게 한다.

`App`은 `panes[]`(채널 id), `paneIndex`(포커스), 창별 `messagesViews[]`를 유지한다.
`selectedChannelId`는 항상 포커스된 창의 채널을 가리키므로 입력/멘션/읽음 처리
경로는 분할 여부를 몰라도 된다. 이미 열린 채널을 다시 열면 그 창으로 포커스만
이동하고, 새 채널은 빈 창에 추가된다. 4개가 모두 차 있으면 `selectPaneFor()`가
포커스된 창을 새 채널로 교체한다. `focusPane()`은 `openChannel(..., { resetScroll:
false })`를 써서 포커스 이동만으로 메시지를 다시 불러오거나 스크롤을 튀기지 않는다.

마우스 클릭은 `paneAt()`으로 창을 찾아 그 창을 포커스하고, 해당 창의 메시지/입력창
사각형 안에서만 링크 열기·입력 포커스를 수행한다. 휠은 포인터 아래 창의 캐시만
스크롤한다. 드래그 선택의 경계(`selectionBounds()`)도 앵커가 속한 창의 메시지
영역으로 제한된다. 라이브 메시지는 화면에 보이는 어느 창이든 맨 아래에 있으면
읽음 처리하고, 아니면 채널 unread 카운트를 올린다. `ctrl+w`는 포커스 창을 닫고
마지막 한 창은 남긴다.

분할 배치(`splitMode`, `panes`, `paneIndex`)는 `lastView.split`으로 저장된다.
복원할 때는 `restoreSplitLayout()`이 저장된 창 id와 포커스를 API 호출 없이 먼저
복원하고, 포커스된 창만 `openChannel()`로 연다. 나머지 창은 채널 객체가 없으면
`channel not loaded (focus to open)` 자리표시자로 그려 두고, 사용자가 그 창을
포커스할 때 `openChannel(..., { resolve: true })`가 `GET /channels/{id}`와 메시지를
그때 불러온다. 따라서 저장된 창이 4개여도 시작 시 메시지 요청은 포커스된 창
1개분만 발생한다.

길드 순서는 `/users/@me/guilds`의 순서가 아니라 `PreloadedUserSettings.guild_folders`
(`GET /users/@me/settings-proto/1`)를 디코딩해 맞춘다. `guild-order.js`는 폴더 트리를
그대로 읽어 `GuildFolder { guild_ids(1), Int64Value id(2), StringValue name(3),
UInt64Value color(4) }`의 래퍼까지 벗겨 낸다. 레일은 `railRows()`가 만드는 평탄한
행 목록으로 그린다: DM 행, 폴더 헤더(`[-]`/`[+]`, 접히면 길드 수 표시), 폴더 안
길드는 `│`로 들여쓰기, 폴더 밖 길드는 그대로. 디스코드는 폴더 밖 길드를 이름/ID가
없는 길드 1개짜리 폴더로 저장하므로 그런 폴더는 헤더 없이 길드 행으로 렌더링한다. 이름 없는
다중 길드 폴더는 `folder` 라벨을 쓴다. READY 페이로드는 REST보다 얇을 수 있으므로
덮어쓰지 않고 id 기준으로 병합한다.

채널 사이드바도 카테고리를 `[-]`/`[+]` 헤더로 접고 펼 수 있다. 접힌 카테고리의
채널은 `sidebarItems()`에서 제외되어 `selectableChannels()`와 클릭 판정이 자동으로
같아진다. 접힘 상태는 디스코드와 마찬가지로 클라이언트 로컬이며, `config.json`의
`collapsedFolders`/`collapsedCategories`에 저장된다. 폴더 키는 id → name →
`ids:...` → (익명 단일 길드) 없음 순으로 정한다.

마지막 화면도 클라이언트 로컬 상태로 저장한다. `App.saveView()`가 종료 시
`lastView { guildId, channelId, dm, wide }`와 서버별 마지막 채널
`lastChannels { guildId: channelId }`를 `config.json`에 기록하고,
`bootstrapSelection()`이 부팅 직후 이를 우선 복원한다. DM → 저장된 길드/채널 →
첫 길드 → 첫 DM 순으로 시도하며, 저장된 대상이 없으면 다음 후보로 폴백한다.
실행 중 서버를 오갈 때는 `openChannel()`이 `lastChannelByGuild`를 갱신하고
`selectGuild()`가 그 서버의 기억된 채널을 먼저 연다. 기억된 채널이 사라졌으면
사이드바에 보이는 첫 채널로 폴백한다. 채널 이동마다 쓰지 않고 종료 시 한 번만
저장하며, `SIGINT`/`SIGTERM`뿐 아니라 터미널 창을 닫을 때 오는 `SIGHUP`도 정상
종료로 처리해 뷰를 남긴다.

파일 드롭은 터미널에서 별도 이벤트가 아니라 bracketed paste로 경로 문자열이
들어온다. `attach.js`가 이를 해석해 실제로 존재하는 일반 파일만 첨부로 받는다.
절대/`~`/상대 경로, `file://` URI, 따옴표·역슬래시로 이스케이프된 공백, 한 줄 전체가
경로인 경우, 줄바꿈으로 구분된 여러 파일을 처리한다. 폴더와 없는 경로는 거부하고
토스트로 알린다. 첨부는 채널별 입력창에 보관되며 입력창 높이가 첨부 행만큼 늘어난다
(최대 4행 + `+N more`). `Ctrl+X`로 마지막 첨부를 제거하고, 본문 없이 첨부만 전송할
수도 있다.

bracketed paste를 쓰지 않고 드롭 경로를 일반 문자로 보내는 터미널도 있다. 이 경우
`App`은 `/`, `~`, `.`, 따옴표, `file://` 같은 경로 시작 문자를 짧게 버퍼링하고
(마지막 문자 뒤 90ms), 버스트가 끝나면 실제 파일인지 확인해 첨부로 바꾼다. 사람이
타이핑할 때는 글자 사이 간격이 벌어지므로, 버퍼 안의 **최대 문자 간격**이 45ms를
넘으면 드롭이 아닌 입력으로 본다. `/help`처럼 슬래시로 시작하는 일반 입력은 구분자
개수(최소 8자, 경로 구분자 2개 이상 또는 `file://`/`~/`/절대 경로 형태)와 이 간격을
함께 보고 텍스트로 남긴다.
`file://` URI가 `f`부터 일반 문자로 들어와도 `file:` 프리픽스를 복원하고,
퍼센트 인코딩된 공백은 `fileURLToPath()`로 디코드한다. 드롭 끝에 따라오는
줄바꿈/Enter는 첨부를 즉시 전송하지 않도록 한 번 소비한다. 이 경로는 입력창에
포커스가 없어도 동작하므로, 레일/사이드바에서 드롭해도 단축키로 오인되지 않는다.

첨부 MIME은 확장자뿐 아니라 파일 앞 32바이트의 시그니처로도 판별한다. 스크린샷
도구가 확장자 없는 임시 파일을 떨어뜨려도 PNG/JPEG/GIF/WebP/BMP/TIFF/AVIF/HEIC를
`image/*`로 인식해 업로드하고, 전송 후 인라인 미리보기 대상이 된다.

클립보드 이미지는 `Ctrl+V`로 붙여넣는다. 터미널의 bracketed paste는 텍스트만
전달하므로 앱이 데스크톱 클립보드를 직접 읽는다(`clipboard-read.js`). 리눅스는
`python3` + PyGObject로 `Gtk.Clipboard.request_targets()`를 호출하고, 타깃에
`image/*`가 있으면 `request_image()`로 픽셀버퍼를 받아
`~/.cache/ttycord/clipboard/clipboard-YYYYMMDD-HHMMSS.png`로 저장한다. GTK
콜백은 메인 루프에서 돌리고 `GLib.timeout_add`로 2초 상한을 두며, Node 쪽에서도
같은 시간에 프로세스를 죽여 응답 없는 클립보드 소유자에 매달리지 않는다.
`text/uri-list`(파일 관리자에서 복사)는 `request_uris()`로 받아 경로 그대로
첨부하고, 그 밖의 텍스트는 `request_text()`로 받아 입력창에 넣는다. 이 헬퍼는
복사 경로가 이미 쓰는 GTK 의존성을 재사용하므로 추가 설치가 필요 없다.
macOS는 `osascript`로 `«class PNGf»`를 파일로 쓰고, Windows는 미지원이다.
임시 PNG는 전송 성공 또는 `Ctrl+X` 제거 시 삭제하고, 남은 파일은 프로세스당 한
번 24시간 TTL로 정리한다.

업로드는 `POST /channels/{id}/messages`에 `payload_json`과 `files[n]` 파트를 담은
멀티파트로 보낸다. `RestClient.request()`는 `FormData`를 받으면 JSON 직렬화와
`Content-Type` 설정을 건너뛰어 fetch가 boundary를 붙이게 한다. 첨부는 최대 10개,
파일당 기본 10MB(`TTYCORD_MAX_UPLOAD_MB`)로 제한하고, 실패하면 대기 중이던
첨부를 입력창에 되돌린다. `client.sendMessageWithFiles()`가 REST까지 전달한다.

멘션은 `mention.js`가 커서 주변의 `@`/`#` 토큰을 찾아 후보를 만들고, `Tab`/`Enter`
또는 클릭으로 `<@id>`/`<#id>` 문법을 삽입한다. 후보는 현재 채널의 최근 작성자,
멘션된 사용자, DM 상대와 현재 길드의 텍스트 채널에서 뽑으며 추가 REST 요청은
보내지 않는다. 빈 `@`는 채널 활동 사용자만 보여 주고, 이름을 입력하면 로컬에
알려진 전체 사용자를 검색한다. `@everyone`/`@here`는 이름을 입력했을 때만
노출해 실수로 전체 멘션을 선택하는 일을 줄인다.

이미지 첨부는 메시지 본문 아래에 인라인으로 그린다. 터미널 이미지 프로토콜
(Kitty/Sixel)을 쓰지 않고, 한 셀에 2×2 픽셀을 담는 사분면 블록 문자와 전경/배경
2색으로 렌더링한다. 셀 격자가 해상도 한계이므로 메시지 창 폭을 꽉 채우고 세로는
종횡비만큼 늘리며, `z`(와이드 모드)로 레일/채널을 숨기면 가로 해상도가 약 2배가
된다. 디코딩은 ImageMagick(`convert`), 폴백은 ffmpeg이며 원본은
`~/.cache/ttycord/images/`에 캐시한다. 이미지 행(또는 `[img]` 라벨 행)을
클릭하면 원본 URL을 기본 브라우저로 연다(`http`/`https`만 허용).

마우스 좌표는 그리는 좌표와 같은 상수에서 계산한다. 레일은 `DM 행 → 구분선 →
railRows()` 한 줄씩 고정 레이아웃이고, 클릭 판정도 `railHitIndex()`/`sidebarHitIndex()`가
같은 산술을 쓰므로 폴더 행이 섞이거나 목록이 스크롤되어도 어긋나지 않는다. 폴더/카테고리
헤더 클릭은 접기·펼치기, 길드/채널 클릭은 열기다.

마우스 보고를 켜 두면 터미널이 텍스트를 선택해 주지 않으므로, 드래그 선택은 앱이 직접
구현한다. `1002`(버튼을 누른 채 움직임) 모드로 드래그 이벤트를 받고,
`selectionRanges()`가 GUI 텍스트 편집기식 선형 범위(첫 줄 anchor→줄 끝, 중간 줄 전체,
마지막 줄 줄 시작→focus)를 계산한다. 범위는 드래그를 시작한 패널의 사각형으로
클램프되어 메시지 창에서 시작한 드래그가 레일/사이드바까지 칠하지 않는다. 이 범위를 그대로 하이라이트에 쓰고
`selectionText()`가 같은 범위에서 텍스트를 뽑으므로 화면 강조와 복사 내용이 항상
일치하며, 사각형 블록 선택이 되지 않는다. 클릭은 누름/뗌이 같은 셀이면 기존 클릭 동작으로 처리하므로 드래그와 클릭이
충돌하지 않는다. 복사는 `wl-copy`/`xclip`/`xsel`을 순서대로 시도하고, 없으면 PyGObject GTK로
X11 선택 영역을 잡았다가 클립보드 매니저에 넘긴다. GTK도 없으면 OSC 52
이스케이프로 폴백한다(VTE는 OSC 52를 지원하지 않아 GTK 경로가 필요하다).
복사 후 선택을 지우고, `Ctrl+C`는 두 번 눌러야 종료되도록 확인 창(2초)을 둔다.

메시지 창은 렌더된 행 배열의
`y0`/`start`를 `messagesView`에 남겨, 클릭한 터미널 행을 그대로 첨부 URL로 되돌린다.

### 4.2 토큰 처리

`resolveToken()`은 CLI 인자 → `DISCORD_TOKEN` → 저장된 설정 → 로컬 leveldb 순으로
찾는다. 로컬 후보는 `/users/@me`로 검증하고, 성공한 첫 토큰만 사용한다. 토큰은
`redactToken()`을 거쳐 `NDUyNz…RvwA`처럼 가려서 출력한다. `login`으로 저장할 때만
설정 파일에 기록하며, TUI 기본 실행은 설정이 없으면 매번 로컬에서 읽는다.

### 4.3 TLS 지문 (기본 켜짐)

디스코드는 헤더 외에 TLS ClientHello(Ja3/Ja4)도 볼 수 있다. Node의 OpenSSL
스택은 Chrome의 암호 목록·확장 순서·GREASE를 재현하지 못하므로, 기본값으로
`spoof-proxy/`의 Go 헬퍼가 `127.0.0.1`에 리스너를 열고 업스트림 연결만
`bogdanfinn/tls-client`의 `Chrome_154` 프로필로 맺는다. `--no-spoof` 또는
`TTYCORD_SPOOF=0`으로 끈다.

- REST는 `HttpClient.Do()`로 실제 HTTP/2 요청을 보내 ALPN, SETTINGS/Akamai
  지문, pseudo-header 순서, 쿠키 jar, Chrome 헤더 순서를 모두 맞춘다.
- Gateway는 WebSocket이므로 h1 리버스 프록시를 유지하되, 핸드셰이크 헤더를
  Chrome과 같은 값·순서로 주입한다.
- `Accept-Encoding: gzip, deflate, br, zstd`를 광고하고 응답은 헬퍼가 직접
  해제한다(Node undici는 zstd 미지원).
- REST와 Gateway가 같은 헬퍼를 지나므로 두 연결의 지문이 일치한다.
- `httputil.ReverseProxy`가 `Connection: Upgrade`를 보존하므로 WebSocket도
  같은 경로로 통과한다.
- 헬퍼는 디스코드를 모르는 범용 egress 프록시라 Node 쪽 데이터 모델 경계가
  생기지 않는다. Node 변경은 base URL 두 개뿐이다.
- 기본값은 켜짐이고, Go 툴체인과 `npm run build:proxy`가 필요하다. **폴백은
  없다.** 바이너리가 없거나 시작에 실패하면 직접 연결로 넘어가지 않고 빌드
  방법을 안내하는 오류로 종료하며, 끄려면 `--no-spoof` /
  `TTYCORD_SPOOF=0`을 명시해야 한다.
- RESUME은 프록시를 써도 유지된다. Node가 `resume_gateway_url`을 로컬 주소로
  바꾸고 실제 호스트를 `X-Spoof-Host`로 넘기며, 헬퍼는 Discord 도메인만
  허용하고 이 헤더를 업스트림으로 전달하지 않는다.

## 5. 검증

### 5.1 실제 서버 검증

로컬 토큰으로 다음을 확인했다(토큰은 출력하지 않음).

- `GET /users/@me` → 200, 본인 계정 정보 정상
- `GET /users/@me/guilds` → 길드 목록 정상
- `GET /users/@me/channels` → DM 목록 정상
- `GET /guilds/{id}/channels` → 카테고리/텍스트 채널 정상
- `GET /channels/{id}/messages` → 최근 메시지 정상
- Gateway `IDENTIFY` → `READY` (길드·DM·읽음 상태 포함)
- `ttycord doctor` → REST/게이트웨이 모두 정상

### 5.2 오프라인 테스트

`node --test` 기준 328개 테스트가 통과한다.

- 눈송이 ID ↔ 시간 변환, 한글/이모지 폭, 멘션/타임스탬프 렌더링
- REST 헤더/JSON/429 재시도/에러 처리/ack payload
- REST 신원이 Chrome 154 웹과 일치하는지 (UA, `Sec-Ch-Ua`, `Priority`)
- leveldb 토큰 추출/검증 (검증 요청도 같은 브라우저 헤더 사용)
- Gateway IDENTIFY/RESUME/READY/heartbeat/close code, `capabilities` 8701
- READY의 버전드 read state와 deduped user 수화
- Gateway `urlLocked`(프록시 사용 시 resume URL 무시)
- TLS 프록시 기동/준비 라인 파싱/조기 종료 처리
- 채널 그룹화, 메시지 그룹화, 인라인 마크다운
- 설정 파일 0600 저장
- TUI 렌더링, 포커스 이동, 입력/전송, 읽음 처리, 실시간 메시지
- 레일/사이드바 클릭 행 → 인덱스 매핑, 이미지 행 → 첨부 URL 매핑
- 폴더 프로토콜 래퍼(id/name/color) 디코딩, 익명 폴더 처리, 폴더 행/접힘/`│` 들여쓰기
- 폴더·카테고리 토글(키/클릭/space), 접힌 카테고리 채널 필터링, 접힘 상태 저장
- 드래그 선택 범위(선형/역방향/한 줄), 텍스트 추출(줄 단위, 와이드 글리프), Ctrl+C 복사/2회 종료, OSC 52 폴백
- 드롭 경로/`file://` URI/공백·따옴표 파싱, 폴더·없는 파일 거부, 10개/10MB 제한
- 멀티파트 `payload_json`+`files[n]` 구성, 첨부 전송 후 입력창 정리/실패 시 복원
- 메시지 커서 이동/클램프, 반응 토글·게이트웨이 반영·실패 롤백, 답장/수정/삭제/링크 복사
- 벨 정책/쿨다운, 타이틀 멘션 수, 멘션 거터 마커
- 펜스 파서(```/~~~, 언어 별칭, 미닫힘), 언어별 토큰 분류, 블록 주석/diff, 렌더 색상

### 5.3 TUI 스모크 테스트

의사 터미널(`script`)에서 TUI를 6초간 실행해 다음을 확인했다.

- 대체 화면 진입/복귀, raw mode 입력
- 토큰 탐색 → REST → Gateway → 길드/채널/메시지 로드
- 채널 자동 읽음 처리 (`ack` 200)
- `SIGTERM` 시 화면 복구

### 5.4 TLS 지문 프록시 검증

디스코드 API는 호출하지 않고 공개/로컬 엔드포인트로만 확인했다.

- `https://tls.peet.ws/api/all`을 프록시 경유로 조회 → `http_version: h2`,
  Ja4 `t13d1517h2_8daaf6152771_cb7bf5808d99`, ALPN `["h2","http/1.1"]`,
  Akamai h2 지문 `1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p`.
  Node 단독 연결에는 GREASE도 h2 SETTINGS도 없다.
- 같은 값을 **헤드리스 Chrome 154**로 조회해 비교 → JA4, ALPN, Akamai 지문이
  문자 단위로 동일. `Sec-Ch-Ua`도
  `"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"`로 동일.
- 실제 Chrome 154의 `fetch()` 헤더를 로컬 서버로 캡처 → GET에는 `Origin`이
  없고 POST/PUT/PATCH/DELETE에만 있음. 이에 맞춰 GET/HEAD에서 `Origin`을
  제거했다.
- 같은 응답의 h2 HEADERS 블록에서 헤더 순서가
  `sec-ch-ua → sec-ch-ua-mobile → sec-ch-ua-platform → authorization →
  user-agent → accept → x-super-properties → ... → accept-encoding →
  accept-language → priority`임을 확인.
- `httpbingo.org`로 쿠키 jar(`foo=bar` 재전송), gzip 응답 해제,
  업스트림이 받은 `Accept-Encoding: gzip, deflate, br, zstd`를 확인.
  로컬 HTTPS 서버로 gzip/deflate/br/zstd/identity 5종 해제를 확인.
- h2 경로에서 연속 12회 요청이 모두 성공(초기 h1 경로의 간헐
  `UND_ERR_SOCKET` 해소).
- 로컬 TLS 서버로 Gateway 핸드셰이크를 덤프해 Chrome 순서의
  `Host → Connection → Pragma → Cache-Control → User-Agent → Upgrade →
  Origin → Sec-Fetch-Mode → ...`와 업그레이드 성공을 확인.
- 프록시가 업스트림 `Host`를 `discord.com`/`gateway.discord.gg`로 재작성하고
  `X-Forwarded-For`를 붙이지 않는 것을 확인.
- 인증이 필요 없는 공개 정적 자산(`discord.com/app`과 그 JS 번들, 빌드
  671535)을 읽어 Super-Properties 생성 코드와 대조했다. `os_arch`/`app_arch`/
  `native_build_number`는 `window.DiscordNative`가 있을 때만 채워지는
  데스크톱 전용 필드였고, 웹은 `device_model_name: ""`을 보내며,
  `client_build_number`는 `GLOBAL_ENV.BUILD_NUMBER`(웹 빌드)였다. 이에 맞춰
  빌드 번호를 671535로 바꾸고 `device_model_name`을 추가했으며 `os_version`을
  UA 파서 값(Linux는 `""`)으로 맞췄다.
- 프록시 경유 RESUME을 로컬 TLS 서버 두 개로 확인했다. `X-Spoof-Host`가
  샤드 호스트를 지정하면 연결이 그 호스트로 가고, 헤더는 업스트림에 남지
  않는다. `discord.gg`가 아닌 호스트는 거부된다(Go 단위 테스트 포함).
- 프록시 바이너리가 없을 때 기본 실행이 네트워크 요청 없이 안내 오류로
  종료하고, `--no-spoof`를 주었을 때만 직접 연결로 진행하는 것을 확인.
- 가짜 프록시로 `--spoof` REST 경로가 `/api/v9/users/@me`를 호출하는지 확인
  (초기 버전은 `/users/@me`로 나가 실제 디스코드에서 404가 될 상태였다).

## 6. 제한과 위험

- 사용자 토큰은 공식 봇 토큰과 달리 이용약관상 허용되지 않는다. 계정 제재 위험이
  있으며, 이 프로젝트는 그 위험을 사용자에게 넘긴다.
- 디스코드가 클라이언트 빌드 번호/헤더를 바꾸면 요청이 거부될 수 있다. 이때
  `DISCORD_CLIENT_BUILD_NUMBER`로 조정한다. 신원은 Chrome 154 웹 클라이언트로
  고정되어 있고 TLS 프로필도 같은 버전이므로, UA만 바꾸면 다시 불일치가 생긴다.
- 비공식 ack 엔드포인트는 예고 없이 바뀔 수 있다.
- 음성, 스레드 생성, 검색은 범위 밖이다. 첨부 업로드는 지원하지만 드래그 앤 드롭이
  터미널의 붙여넣기 경로에 의존하므로 터미널/파일 관리자에 따라 경로가 아닌 내용이
  붙여넣어질 수 있다.
- 로컬 leveldb 탐색은 디스코드가 실행 중일 때 파일이 잠겨 있을 수 있다. 읽기
  전용으로 시도하며, 실패하면 다음 파일/경로로 넘어간다.
- TLS 지문 프록시는 Go 툴체인과 `npm run build:proxy`가 필요하고, 플랫폼별로
  한 번 빌드해야 한다. 빌드하지 않으면 클라이언트는 시작하지 않는다(폴백 없음).
  Go 없이 쓰려면 `--no-spoof`를 명시해야 하고, 그 경우 TLS 계층은 Chrome 지문이
  아니다.

## 7. 결론

공식 클라이언트의 로컬 파일에서 확인한 클라이언트 신원/토큰 저장 방식과 공개
프로토콜 문서를 결합해, 의존성 없는 Node.js 디스코드 TUI를 구현했다. 핵심 기능인
로그인, 서버/채널/DM 목록, 기록 읽기, 전송, 실시간 수신, 읽음 처리가 실제 서버에서
동작함을 확인했다. 다만 사용자 토큰 기반 클라이언트의 약관/제재 위험은 설계상
해소할 수 없으므로, 개인 학습용으로만 사용해야 한다.
