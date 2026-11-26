# ttycord — 비공식 디스코드 터미널 클라이언트

디스코드 데스크톱 클라이언트가 사용하는 **REST API v9**와 **Gateway WebSocket**을
Node.js로 직접 사용하는 최소 기능 터미널 클라이언트입니다. 명령줄 도구와 실시간
분할 화면 TUI를 함께 제공합니다.

> **English** — `ttycord` is an unofficial, personal-use Discord terminal client
> built directly on REST v9 and the Gateway WebSocket. It ships a full-screen
> TUI, inline images, split view and an optional Chrome-TLS egress proxy.
> Requires Node.js 22+; the proxy helper needs Go. It is **not affiliated with,
> endorsed by, or supported by Discord Inc.** See the warning below.

- 런타임 의존성 **0개** (Node.js 22 이상, 내장 `fetch`/`WebSocket` 사용)
- Chrome TLS 지문 프록시 기본 사용 (Go 헬퍼를 한 번 빌드, 폴백 없음)
- 로그인(로컬 토큰 자동 탐색), 서버/채널/DM 목록, 메시지 기록, 전송
- 실시간 메시지 수신, 입력 중 표시, 읽음 처리
- 멘션/알림 켜둔 채널에 시스템 사운드 알림 (Discord 채널별 알림 설정 반영)
- 파일/이미지를 터미널로 끌어다 놓아 첨부 전송 (최대 10개, 파일당 10MB)
- 여러 줄 입력 (`ctrl+enter` / `alt+enter` / `ctrl+j`), 입력창 최대 6줄 자동 확장
- `@`/`#` 멘션 자동완성 (사용자·채널, 키보드/마우스 선택)
- 최대 4개 채널/DM을 2×2 그리드로 보는 분할 보기 (넘치면 포커스 창이 새 채널로 교체)
- 길드 레일 + 채널 사이드바 + 메시지/입력창 TUI, 마우스 클릭/휠 지원
- 토큰은 전체를 화면에 출력하지 않으며, 저장 시 `0600` 권한 사용

> **경고**: 사용자 토큰으로 동작하는 비공식 클라이언트는 디스코드 이용약관에
> 위배될 수 있습니다. 계정 제재, 토큰 무효화 등 모든 위험은 사용자에게 있습니다.
> 이 프로젝트는 학습/개인 사용 목적의 프로토타입입니다.

## 설치

요구 사항:

- **Node.js 22 이상** (내장 `fetch`/`WebSocket` 사용, 런타임 npm 의존성 없음)
- **Go 1.27 이상** — Chrome TLS 지문 프록시를 빌드할 때만 필요
- Linux/macOS 터미널 (Windows는 일부 기능 제한)

### GitHub에서 설치

```bash
git clone https://github.com/jy-ha/ttycord.git
cd ttycord

# TLS 지문 프록시 빌드 (한 번만)
npm run build:proxy

# 저장소에서 바로 실행
node bin/ttycord.js --help

# 전역 명령으로 연결
npm link            # 또는 npm install -g .
ttycord --help
```

`npm link`는 저장소를 직접 가리키므로 코드를 수정한 뒤 재설치 없이
`ttycord`를 재시작하기만 하면 됩니다. `npm install -g .`는 파일을 복사하므로
수정할 때마다 다시 설치해야 합니다.

프록시는 기본값이고 **폴백이 없으므로**, 실제 명령을 쓰려면 처음 한 번
`npm run build:proxy`가 필요합니다. Go 없이 쓰려면 `--no-spoof`를 명시하세요
(이 경우 TLS 계층은 Chrome 지문이 아닙니다).

> 이 프로젝트는 npm에 배포되어 있지 않습니다. 위 GitHub 저장소에서 직접
> 설치하세요.

## 토큰

우선순위는 다음과 같습니다.

1. `--token <토큰>`
2. `DISCORD_TOKEN` 환경 변수
3. `~/.config/ttycord/config.json` (`ttycord login`으로 저장)
4. 로컬 디스코드 데스크톱 클라이언트의 `Local Storage/leveldb` (읽기 전용 탐색)

로컬 탐색은 다음 위치를 확인합니다.

- Flatpak: `~/.var/app/com.discordapp.Discord/config/discord/Local Storage/leveldb`
- Canary/PTB Flatpak 및 일반 설치 경로
- macOS `~/Library/Application Support/discord/...`
- Windows `%APPDATA%\discord\...`

`TTYCORD_TOKEN_DIRS`에 콜론(`:`)으로 구분한 경로를 지정하면 탐색 위치를
바꿀 수 있습니다.

```bash
# 로컬 클라이언트에서 찾은 토큰을 검증하고 저장
ttycord login

# 직접 지정
ttycord login --token "..."

# 토큰 출처와 사용자만 확인 (토큰은 가려서 출력)
ttycord token

# 저장된 토큰 삭제
ttycord logout
```

토큰 저장 위치는 `TTYCORD_CONFIG_DIR`로 바꿀 수 있습니다. 토큰 파일은
`0600`으로 생성됩니다. 이전 `discord-tui` 설정이 남아 있으면 첫 실행 시
`~/.config/ttycord/config.json`으로 자동 복사됩니다.

## CLI

```bash
ttycord me
ttycord guilds
ttycord channels <서버ID>
ttycord dms
ttycord messages <채널ID> --limit 20
ttycord messages <채널ID> --before <메시지ID>
ttycord send <채널ID> "안녕하세요"
echo "파이프 입력" | ttycord send <채널ID>
ttycord ack <채널ID> [메시지ID]
ttycord watch <채널ID>          # 실시간 출력
ttycord watch --all             # 모든 채널 실시간 출력
ttycord doctor                  # 토큰·REST·게이트웨이 점검
```

`--json`을 붙이면 목록/메시지를 JSON으로 출력합니다. `--debug`는
`$TMPDIR/ttycord-debug.log`에 요청/게이트웨이 로그를 남깁니다(토큰 제외).

## TUI

```bash
ttycord          # 또는 ttycord tui
ttycord tui --dump --width 110 --height 34   # 네트워크 없이 화면 미리보기
```

TUI는 터미널 대체 화면(alternate screen)에서 실행됩니다. 좁은 터미널에서는
길드 레일이 숨겨지고 채널 사이드바 + 메시지 창만 표시됩니다.

### 키

| 키 | 동작 |
| --- | --- |
| `tab` / `shift+tab` | 서버 레일 → 채널 → 입력창 전환 |
| `j` / `k`, `↑` / `↓` | 목록/메시지 커서 이동, 입력창에서는 줄 이동 후 전송 기록 |
| `g` / `G` | 메시지 커서를 처음 / 마지막으로 |
| `enter` | 서버/채널 열기, 메시지 전송 |
| `ctrl+enter`, `alt+enter`, `ctrl+j` | 입력창에서 줄바꿈 (전송하지 않음) |
| `space` | 선택한 길드 폴더 / 채널 카테고리 접기·펼치기 |
| `esc` | 답장·수정 취소 → 메시지 모드 탈출 → 채널 목록, 선택 해제 |
| `m` | 메시지 커서 시작 (액션 키 대상) |
| 메시지 클릭 | 메시지 커서 + 클릭 가능한 액션 메뉴 (반응/답장/수정/삭제/링크 복사) |
| `r` | 선택한 메시지에 반응 (`1`-`8` 즉시, 또는 이름/이모지 입력) |
| `R` | 선택한 메시지에 답장 |
| `e` / `d` | 내 메시지 수정 / 삭제 (`d`는 두 번) |
| `y` | 선택한 메시지의 링크 복사 |
| `h` / `l`, `←` / `→` | 패널 이동 |
| `pageup` / `pagedown` | 메시지 스크롤 (위쪽 끝에서 이전 메시지 자동 로드) |
| `i` | 인라인 이미지 표시 켜기/끄기 |
| `z` | 와이드 모드 (레일/채널 숨김, 이미지가 터미널 전체 폭 사용) |
| `s` | 분할 보기 켜기/끄기 (최대 4개, 2×2 그리드) |
| `1`-`4` | 분할 창 포커스 이동 |
| `ctrl+←` / `ctrl+→` | 이전 / 다음 분할 창 |
| `ctrl+w` | 포커스된 분할 창 닫기 |
| `ctrl+r` | 최근 메시지 다시 불러오기 |
| `ctrl+u` | 입력 내용 지우기 |
| `ctrl+x` | 대기 중인 첨부 마지막 하나 제거 |
| `ctrl+v` | 클립보드의 이미지/파일을 첨부로 붙여넣기 (텍스트는 입력창에) |
| 드래그 | 화면의 텍스트를 선택 (하이라이트) |
| 파일 드래그 | 터미널에 파일을 끌어다 놓으면 첨부로 추가 |
| `ctrl+c` | 선택 영역 복사; 두 번 누르면 종료 |
| `?` | 도움말 |
| 마우스 클릭 | 레일에서 서버/DM 열기, 폴더/카테고리 헤더 접기·펼치기, 사이드바에서 채널 열기, 메시지 액션 메뉴 열기, 인라인 이미지/`[img]` 라벨을 브라우저로 열기 |
| 마우스 휠 | 메시지/목록 스크롤 |

채널을 열면 마지막 메시지까지 자동으로 읽음 처리하고, 보고 있는 채널에 새 메시지가
오면 (스크롤이 맨 아래일 때) 역시 자동으로 처리합니다. 별도의 수동 읽음 처리 키는
두지 않았습니다. 분할 보기에서도 화면에 보이는 창이 맨 아래에 있으면 해당 채널을
자동으로 읽음 처리합니다.

### 알림

새 메시지가 화면에 보이지 않거나 스크롤이 위쪽일 때 소리로 알려주고,
터미널 타이틀에 멘션 수를 표시합니다(`ttycord !1`). 멘션된 메시지는 왼쪽 거터에 `!`로
표시됩니다.

Discord의 **채널별 알림 설정**을 그대로 따릅니다.

| 채널 설정 | 동작 |
| --- | --- |
| 모든 메시지 | 보이지 않는 새 메시지마다 소리 |
| 멘션만 | 나를 멘션한 메시지에만 소리 |
| 없음 / 채널·서버 음소거 | 소리 없음 (타이틀/거터 표시는 유지) |

READY에서 설정을 아직 받지 못했거나 DM 설정이 없을 때만 `TTYCORD_BELL` 정책을
사용합니다.

| `TTYCORD_BELL` | 동작 |
| --- | --- |
| `mention` (기본) | Discord 설정이 없을 때 멘션에만 |
| `all` | Discord 설정과 무관하게 모든 채널에서 소리 |
| `off` | 마스터 음소거 (모든 소리 끔) |

소리는 터미널 벨(`\x07`) 대신 시스템 사운드로 재생합니다. 기본값은 freedesktop의
`message-new-instant` 계열 파일이고, 재생기는 `paplay` → `pw-play` → `aplay` →
`afplay` 순서로 찾습니다. 사운드 파일이나 재생기가 없으면 터미널 벨로 대체됩니다.

| `TTYCORD_SOUND` | 동작 |
| --- | --- |
| `auto` (기본) | 시스템 사운드 재생, 실패 시 터미널 벨 |
| `off` | 소리 없음 |
| `bell` | 터미널 벨만 |
| `/path/file.oga` | 지정한 파일 재생 |

`TTYCORD_SOUND_CMD`로 재생 명령을 직접 지정할 수 있습니다. 소리는 1.5초 쿨다운이
있어 연속 메시지로 요란해지지 않습니다.

### 분할 보기

`s`로 분할 보기를 켜면 채널/DM을 열 때마다 새 창이 추가됩니다. 창 배치는 개수에
따라 달라집니다: 1개는 전체 화면, 2개는 좌우 2열, 3개는 위쪽 2열 + 아래쪽 1열
(전체 폭), 4개는 **2×2 그리드**입니다. 최대 4개까지 표시되며, 이미 열려 있는
채널을 다시 열면 그 창으로 포커스만 이동합니다. 4개가 모두 차 있는 상태에서 새
채널을 열면 **현재 포커스된 창이 새 채널로 교체**됩니다.

각 창은 자체 헤더/메시지/입력창을 가지며, 입력창 높이는 가장 긴 초안에 맞춰 모든
창이 같은 기준선을 유지합니다. 포커스된 창은 헤더와 입력창 테두리가 밝게 표시되고,
상태바에 `2/4`처럼 현재 위치가 나옵니다. 마우스로 창을 클릭해 포커스할 수 있고,
그 창의 메시지 영역에서 휠을 굴리면 그 창만 스크롤됩니다. `ctrl+w`로 포커스된 창을
닫고, 마지막 한 창은 닫히지 않습니다(분할 자체는 `s`로 끔). 창이 좁으면 `z` 와이드
모드를 함께 쓰는 편이 읽기 좋습니다.

분할 배치와 포커스는 `lastView.split`에 함께 저장되어 다음 실행에서 그대로
복원됩니다. 다만 시작할 때 저장된 창마다 메시지를 미리 가져오지는 않습니다.
포커스된 창만 즉시 열고, 나머지 창은 `channel not loaded (focus to open)` 자리표시자로
남겨 두었다가 해당 창을 클릭/포커스할 때 그때 채널 정보와 메시지를 불러옵니다.
따라서 분할 창이 4개여도 앱 시작 시 API 요청 수는 단일 창 실행과 거의 같습니다.

마지막으로 열었던 화면은 종료할 때 `config.json`의 `lastView`에 저장되고, 다음
실행에서 그대로 복원됩니다. 길드의 특정 채널을 열어 두었다면 같은 길드/채널로,
DM을 열어 두었다면 같은 DM으로 돌아가며, 와이드 모드(`z`) 상태도 함께 복원됩니다.
저장된 길드나 채널이 사라졌으면 첫 길드/첫 채널로, DM이 사라졌으면 첫 길드로
폴백합니다. 창을 닫아 종료(SIGHUP)해도 저장됩니다.

실행 중에 서버를 오갈 때도 각 서버에서 마지막으로 보던 채널을 기억합니다.
서버를 다시 열면 그 서버의 첫 채널이 아니라 읽고 있던 채널로 돌아갑니다. 이
서버별 기억(`lastChannels`)도 종료 시 함께 저장되어 다음 실행에서 유지되며,
기억해 둔 채널이 삭제되었으면 그 서버의 첫 표시 채널로 폴백합니다.

### 텍스트 선택/복사

마우스 드래그로 화면의 아무 텍스트나 선택할 수 있습니다. GUI 텍스트 편집기처럼
줄 단위로 이어지는 선택(첫 줄은 시작점→줄 끝, 마지막 줄은 줄 시작→끝점, 중간 줄은
전체)이며 사각형 블록 선택이 아닙니다. 선택은 드래그를 시작한 패널(분할 창의 메시지
영역 포함) 안으로 제한되어 다른 패널을 칠하지 않습니다. 선택 영역은 강조 표시되고,
`ctrl+c`로 클립보드에 복사합니다. 복사 후 선택은 해제되며, 한 번 더 `ctrl+c`를
누르면 종료됩니다. 선택이 없을 때도 두 번 누르면 종료되므로 실수로 눌러도
바로 꺼지지 않습니다. 선택 상태에서 `esc`는 복사하지 않고 취소만 합니다.

복사는 `wl-copy` → `xclip` → `xsel` → GTK(PyGObject) 순으로 시도하고, 모두 없으면
OSC 52로 터미널에 직접 전달합니다(SSH에서도 동작). GTK 폴백은 VTE/GNOME
터미널처럼 OSC 52를 지원하지 않는 환경에서도 동작합니다. 터미널 자체 선택을 쓰고 싶으면
`shift`를 누른 채 드래그하면 됩니다(대부분의 터미널이 마우스 보고를 우회).

### 멘션

입력창에서 `@`를 치면 현재 채널에서 활동한 사용자와 DM 상대가, `#`를 치면 현재
서버의 텍스트 채널이 후보로 뜹니다. 계속 입력해 이름으로 거를 수 있고,
`↑`/`↓`로 고른 뒤 `tab` 또는 `enter`로 삽입합니다. 후보를 마우스로 클릭해도 됩니다.
삽입되는 값은 실제 멘션 문법(`<@id>`, `<#id>`)이므로 Discord에서 알림이 갑니다.
`esc`는 메뉴만 닫고 입력 내용은 유지합니다. 후보는 이미 받아 둔 사용자/채널
정보에서 만들기 때문에 추가 API 요청은 없습니다. `@everyone`/`@here`는 이름을
입력했을 때만 후보에 나타납니다.

### 여러 줄 입력

입력창은 여러 줄을 지원합니다. `ctrl+enter`를 누르면 메시지를 보내지 않고 줄바꿈을
넣고, `enter`는 그대로 전송합니다. `alt+enter`와 `ctrl+j`도 같은 줄바꿈입니다.
입력 내용이 길어지면 입력창이 최대 6줄까지 늘어나고, 그 이상은 입력창 안에서
스크롤됩니다. `↑`/`↓`는 여러 줄일 때 커서를 줄 사이로 옮기며, 맨 위/아래에서 한 번
더 누르면 전송 기록을 불러옵니다. 붙여넣은 여러 줄 텍스트도 줄바꿈이 유지되며,
CRLF는 `\n`으로 정규화되고 탭은 공백으로 바뀝니다. 붙여넣은 내용이 전부 파일
경로일 때만 첨부로 해석하므로, 경로가 섞인 로그나 스택트레이스도 텍스트로
그대로 들어갑니다.

터미널이 수정 키를 구분해 보고하면(`modifyOtherKeys` 또는 kitty keyboard
protocol) `ctrl+enter`가 바로 동작합니다. VTE 0.68(GNOME Terminal 등)처럼 이 기능이
없는 터미널에서는 `ctrl+enter`가 `enter`와 같은 바이트로 도착하므로, 이때는
`alt+enter` 또는 `ctrl+j`를 사용하세요.

### 파일 첨부 (드래그 앤 드롭)

파일 관리자에서 파일을 터미널 창으로 끌어다 놓으면 입력창에 첨부로 추가됩니다.
터미널은 드롭을 별도 이벤트로 주지 않고 경로(또는 `file://` URI)를 붙여넣기로
전달하므로, 앱이 그 텍스트를 실제 파일로 해석합니다.

- 절대 경로, `~` 경로, `file://` URI, 공백이 있는 경로(따옴표/역슬래시 이스케이프
  또는 한 줄 전체), 줄바꿈으로 구분된 여러 파일을 인식합니다.
- bracketed paste를 지원하지 않고 드롭 경로를 일반 문자로 흘려보내는 터미널
  (VTE/GNOME Terminal 등)도 경로가 짧은 시간에 몰려 들어오는 것을 감지해 첨부로
  바꿉니다. 글자 사이 간격이 벌어지는 사람의 타이핑은 텍스트로 남고, 드롭은 입력창
  포커스와 무관하게 동작하며, 드롭 끝의 줄바꿈이 첨부를 곧바로 전송하지 않습니다.
- 스크린샷 도구가 확장자 없이 떨어뜨린 파일도 앞부분 바이트(PNG/JPEG/GIF/WebP/
  BMP/TIFF/AVIF/HEIC)를 읽어 `image/*`로 인식합니다.
- 실제로 존재하는 **일반 파일**만 첨부합니다. 없는 경로는 "파일을 찾을 수 없습니다",
  폴더는 "폴더는 첨부할 수 없습니다" 토스트로 알려줍니다.
- 한 번에 최대 **10개**, 파일당 기본 **10MB**까지입니다. 더 큰 파일은 전송 전에
  거부합니다(`TTYCORD_MAX_UPLOAD_MB`로 한도 조정).
- 첨부는 채널별 입력창에 보관되고 `[img]`/`[file]` 이름·크기로 표시됩니다.
  `ctrl+x`로 마지막 첨부를 제거하고, 본문 없이 첨부만으로도 `enter` 전송이 됩니다.
- 업로드는 Discord의 `payload_json` + `files[n]` 멀티파트 형식으로 전송합니다.
  실패하면 대기 중인 첨부를 입력창에 되돌려 놓습니다.
- 일반 텍스트 붙여넣기는 그대로 입력창에 들어갑니다(파일로 해석되지 않을 때).

### 클립보드에서 붙여넣기 (ctrl+v)

터미널은 붙여넣기 이벤트로 **텍스트만** 넘겨줍니다. 스크린샷을 찍어 클립보드에
복사한 이미지는 터미널을 거치지 않으므로, `ctrl+v`를 누르면 앱이 데스크톱
클립보드를 직접 읽습니다.

- 리눅스는 `python3` + PyGObject(GTK) 헬퍼로 클립보드를 읽습니다. 복사 경로가 이미
  쓰는 것과 같은 의존성이라 추가 설치가 필요 없습니다.
- 클립보드에 이미지가 있으면 `~/.cache/ttycord/clipboard/`에
  `clipboard-YYYYMMDD-HHMMSS.png`로 저장하고, 드래그한 파일과 똑같이 첨부로
  대기시킵니다. 전송하거나 `ctrl+x`로 제거하면 임시 파일을 지우고, 보내지 않은
  파일은 24시간 뒤 자동 정리합니다.
- 파일 관리자에서 파일을 복사해 둔 경우(`text/uri-list`)에는 그 파일들을 그대로
  첨부합니다.
- 이미지가 없으면 클립보드의 텍스트를 입력창에 붙여넣습니다. 복사한 텍스트가
  파일 경로뿐이면 첨부로 해석합니다.
- 붙여넣을 내용이 없거나 헬퍼를 쓸 수 없으면 토스트로 알려줍니다.
- macOS는 `osascript`로 PNG 클립보드를 읽고, Windows는 지원하지 않습니다.

### 이미지 (인라인)

이미지 첨부는 메시지 본문 아래에 인라인으로 그려집니다. 터미널 이미지 프로토콜
(Kitty/Sixel) 대신, 한 셀에 2×2 픽셀을 담는 사분면 블록 문자
(`▘▝▖▗▚▞▌▐▀▄█` …)와 전경/배경 2색으로 렌더링합니다.

- 해상도의 한계는 셀 격자입니다. 100칸 × 30행 메시지 창이면 최대 200×60 픽셀.
  그래서 이미지는 메시지 창 폭을 꽉 채우고, 세로는 종횡비만큼 늘어납니다(스크롤로 봄).
  `z`로 레일/채널 목록을 숨기면 채팅 창이 터미널 전체 폭이 되어 가로 해상도가
  약 2배가 됩니다.
- 각 셀은 4픽셀을 2색으로 나누는 최적 분할(k-means 2회)로 사분면 글리프를 고르고,
  색은 채널당 5비트로 양자화합니다.
- 일반 셀 격자에 그려지므로 diff 렌더러·스크롤과 충돌하지 않고 깜빡이지 않습니다.
- `i`로 인라인 이미지를 끄고 켤 수 있습니다.
- 이미지(또는 아직 디코드되지 않은 `[img]` 라벨)를 **클릭하면 원본 URL을 기본
  브라우저로 엽니다**. `xdg-open`(Linux) / `open`(macOS) / `start`(Windows)를 쓰며
  `http`/`https`만 허용합니다. 클릭 판정은 이미지가 그려진 화면 행과 1:1로 맞춰져
  있습니다.

디코딩은 ImageMagick(`convert`)을 쓰고, 없으면 `ffmpeg`로 폴백합니다. 둘 다 없으면
`[img] 파일명` 라벨만 남습니다. 채널을 열면 최근 이미지 최대 24개를 동시 2개씩
내려받아 `~/.cache/ttycord/images/`(또는 `$XDG_CACHE_HOME`)에 캐시합니다. CDN
URL은 서명되어 있어 토큰 없이 받고, 401/403일 때만 인증 헤더로 한 번 재시도합니다.
SVG는 렌더링하지 않고, GIF는 첫 프레임만 표시합니다.

## 동작 방식

### REST

- Base URL: `https://discord.com/api/v9`
- 데스크톱 클라이언트와 같은 `User-Agent`, `X-Super-Properties`,
  `X-Discord-Locale`, `X-Discord-Timezone` 헤더를 보냅니다.
- 라우트별 rate limit 버킷을 추적하고, `429`/`5xx`는 지수 백오프로 재시도합니다.
- 모든 요청은 **하나의 큐로 직렬화**되고 최소 120ms 간격을 둡니다. 동시에 나가는
  요청은 없습니다.
- 사용 API: `/users/@me`, `/users/@me/guilds`, `/users/@me/channels`,
  `/guilds/{id}/channels`, `/channels/{id}/messages`,
  `POST /channels/{id}/messages`, `POST /channels/{id}/typing`,
  `POST /channels/{id}/messages/{mid}/ack`.

### 키 입력 보호

키를 누르는 속도가 곧 요청 속도가 되지 않도록 TUI 쪽에 별도 가드를 둡니다.
디스코드의 한도는 **채널 단위**라서 전역 간격만으로는 부족합니다.

| 조작 | 가드 |
|---|---|
| 채널 이동 | 120ms 디바운스 + 세대 카운터. 목록을 훑는 동안에는 지나간 채널을 조회하지 않고, **멈춘 채널만** 불러옵니다. |
| `ctrl+r` 재로드 | 1.5초 쿨다운 (메시지 조회는 채널당 5회/5초) |
| 메시지 전송 | 채널당 5초에 4회까지. 초과하면 초안을 **보존한 채** 거절합니다. |
| 타이핑 표시 | 채널당 8초에 1회, `--no-typing`으로 끌 수 있음 |
| 읽음 처리 | 채널당 2초에 1회, 밀린 요청은 최신 ID 하나로 합칩니다. |
| 이전 메시지 | 최상단 도달 시 1회, 로딩 중에는 재요청 없음 |
| 게이트웨이 재연결 | 1→30초 지수 백오프 |

### Gateway

- `wss://gateway.discord.gg/?v=9&encoding=json`
- `HELLO` → `IDENTIFY`(`capabilities: 8701`, `compress: false`) → `READY`
- 41.25초 하트비트, 하트비트 후 10초 안에 ACK가 없으면 좀비 연결로 판단하고 재연결
- `op 7` 재연결, `op 9` invalid session 처리
- 세션이 남아 있으면 `RESUME`, 아니면 새 `IDENTIFY`
- `4004`, `4010`~`4014`는 치명적 오류로 재시도하지 않음

### 절전/재개

노트북을 덮었다 열거나 `Ctrl+Z` 후 `fg`로 돌아오면 타이머와 WebSocket이
멈춘 것처럼 보일 수 있습니다. 1초 시계가 `Date.now()`의 큰 점프(10초 이상)를
감지하면 다음을 수행합니다.

- 열려 있는 것처럼 보이는 소켓에 즉시 하트비트를 보내 살아 있는지 확인합니다.
  하트비트가 이미 미결 상태였거나 10초 안에 ACK가 없으면 **백오프를 건너뛰고
  바로** 재연결합니다. 세션이 남아 있으면 `RESUME`으로 밀린 이벤트를 받습니다.
- `SIGCONT`도 같은 경로를 즉시 실행합니다.
- 터미널이 잠자는 동안 화면 버퍼를 잃었을 수 있으므로 다음 프레임을
  전체 다시 그립니다.
- 게이트웨이가 다시 `online`이 되면 1.5초 뒤 화면 맨 아래에 있는 보이는
  채널/분할 창을 REST에서 최신 50개로 다시 불러옵니다. 위로 스크롤해 읽던
  창은 건드리지 않습니다.
- 강제 재로드가 실패해도 기존에 보던 메시지는 지우지 않습니다.
- 복귀 직후 Wi-Fi나 프록시의 죽은 keep-alive 연결 때문에 `502 upstream error`가
  날 수 있습니다. 이때는 **조용히** 2·5·10·20초 간격으로 재시도하고, 마지막
  시도까지 실패했을 때만 `ctrl+r` 안내를 표시합니다.
- Go 프록시도 벽시계 점프(10초 이상)를 감지해 풀에 남은 upstream 연결을 버립니다.

### 읽음 처리

Discord 공식 문서에는 사용자 토큰용 읽음 API가 없지만, 공식 클라이언트는
`POST /channels/{channel_id}/messages/{message_id}/ack`에 `{ "token": null }`을
보냅니다. 이 프로젝트도 같은 요청을 사용하며, 실패해도 UI 동작에는 영향을 주지
않습니다.

### TLS 지문 (기본 켜짐)

디스코드는 HTTP 헤더뿐 아니라 TLS ClientHello(Ja3/Ja4)도 본다고 알려져 있습니다.
Node의 OpenSSL 스택은 Chrome의 암호 목록·확장 순서·GREASE를 재현할 수 없습니다.
그래서 **기본값이 켜짐**입니다. 끄면 헤더를 아무리 맞춰도 TLS 계층에서
어긋나므로, 지문 위장이 목적이면 프록시가 사실상 필수입니다.

`spoof-proxy/`의 작은 Go 헬퍼가 `127.0.0.1`에 리스너를 열고,
**업스트림 연결만** `bogdanfinn/tls-client`(Chrome 154 프로필)로 맺습니다.
REST와 Gateway가 같은 헬퍼를 지나므로 두 연결의 TLS 지문이 일치합니다.

```bash
npm run build:proxy      # Go 툴체인 필요 (한 번만)
ttycord              # 기본으로 프록시 사용
ttycord --no-spoof   # 프록시 없이 직접 연결
```

두 업스트림은 Chrome과 같은 방식으로 처리합니다.

- **REST**: `tls-client`의 `HttpClient.Do()`로 실제 HTTP/2 요청을 보냅니다.
  ALPN(`h2, http/1.1`), SETTINGS/Akamai 지문, pseudo-header 순서, 쿠키 jar,
  Chrome 헤더 순서(`sec-ch-ua` → `authorization` → `user-agent` → ... →
  `priority`)가 모두 맞습니다. `Accept-Encoding: gzip, deflate, br, zstd`를
  광고하고 응답은 헬퍼가 직접 해제합니다(Node undici는 zstd 미지원).
- **Gateway**: WebSocket은 HTTP/1.1이므로 h1 리버스 프록시를 유지하되,
  `Origin`, Chrome UA, `Sec-Fetch-Mode`, `Accept-Encoding`, `Accept-Language`를
  주입하고 헤더 순서를 Chrome과 같게 씁니다.

클라이언트 신원도 **Chrome 154 웹**으로 통일되어 있습니다. UA,
`Sec-Ch-Ua`(Chromium의 GREASE 알고리즘), Super-Properties의
`browser`/`browser_version`, TLS ClientHello가 모두 같은 버전을 말합니다.

- 기본값은 켜짐이고, **폴백은 없습니다.** 프록시 바이너리가 없거나 시작에
  실패하면 직접 연결로 조용히 넘어가지 않고 빌드 방법을 알려주는 오류로
  종료합니다. 끄는 방법은 `--no-spoof` 또는 `TTYCORD_SPOOF=0`을 명시하는
  것뿐입니다.
- 헬퍼는 디스코드를 모르는 범용 egress 프록시라 데이터 모델 경계가 생기지
  않습니다.
- `TTYCORD_SPOOF_PROXY`로 바이너리 경로를 지정할 수 있습니다.
- `TTYCORD_LOCALE`(기본 `ko-KR`)이 `system_locale`, `Accept-Language`를
  결정하고, `X-Discord-Locale`은 Discord 열거형으로 정규화됩니다(`ko-KR` → `ko`).

## 보안과 개인정보

- 토큰은 로그, 오류 메시지, 화면에 전체가 출력되지 않습니다.
- 로컬 leveldb는 **읽기 전용**으로만 읽습니다.
- `login`으로 저장한 토큰 파일은 `0600`입니다.
- `me --json`은 디스코드 사용자 객체를 그대로 출력하므로 이메일 등이 포함될 수
  있습니다. 공유 전에 확인하세요.
- 이 도구는 메시지 내용을 외부로 전송하지 않습니다.
- 프록시를 쓰면 헬퍼와 이 프로세스 사이 구간만 루프백 평문입니다. 디스코드까지의
  구간은 여전히 TLS이며, 인증서 검증도 그대로 합니다. RESUME으로 샤드 호스트에
  붙을 때도 프록시가 Discord 도메인만 허용합니다.

## 제한 사항

- 음성/화상, 스레드 생성, 검색, 포럼 채널은 지원하지 않습니다.
- 마크다운은 굵게/기울임/인라인 코드/스포일러/멘션/타임스탬프와 펜스 코드블록
  구문 강조(JS/TS, Python, Go, Rust, Shell, C/C++, SQL, JSON, HTML/CSS, diff)를
  렌더링합니다. 언어를 모르면 색 없이 원문만 표시합니다.
- 이미지는 메시지 본문에 인라인으로 그립니다. 셀 격자 기반이라 해상도는 창 크기에
  비례합니다(그래픽 프로토콜 미사용). 동영상/GIF 애니메이션은 지원하지 않습니다.
- 서버 목록 순서는 `GET /users/@me/settings-proto/1`의 `PreloadedUserSettings.guild_folders`
  (필드 14)를 디코딩해 디스코드 클라이언트와 같게 맞춥니다. 폴더는 헤더(`[-]`/`[+]`)로
  표시되고 접기/펼치기가 가능하며, 이름 없는 폴더는 `folder`로 표시합니다. 설정을 못 읽으면
  REST가 준 순서로 폴백합니다. 접힘 상태는 디스코드처럼 클라이언트 로컬
  (`config.json`의 `collapsedFolders`/`collapsedCategories`)에 저장됩니다.
- 채널 카테고리도 `[-]`/`[+]` 헤더로 접기/펼치기가 가능합니다.
- `client_build_number`는 Discord 웹 빌드(현재 671535)입니다. 웹 빌드가 올라가면
  `DISCORD_CLIENT_BUILD_NUMBER` 환경 변수로 맞출 수 있습니다. 신원은 Chrome 154 웹 클라이언트로 고정되어
  있으며, TLS 프로필도 같은 버전을 씁니다.

## 개발

```bash
npm test                 # 오프라인 테스트 (328개)
npm run dump             # TUI 미리보기
npm run build:proxy      # TLS 지문 헬퍼 빌드 (Go 필요, 기본 사용)
```

주요 파일:

```
bin/ttycord.js        실행 파일
src/cli.js                CLI 명령
src/client.js             REST 래퍼 + 토큰 해석
src/live.js               게이트웨이 이벤트 → UI 이벤트
src/store.js              토큰 설정 저장
src/token-source.js       로컬 leveldb 토큰 탐색/검증
src/spoof.js              TLS 지문 프록시 프로세스 관리 (기본 켜짐)
src/protocol/rest.js      REST 클라이언트
src/protocol/gateway.js   Gateway WebSocket
src/protocol/properties.js 클라이언트 신원/슈퍼 프로퍼티
src/protocol/guild-order.js 길드 폴더 트리/순서 디코더 (settings-proto)
src/tui/                  터미널 렌더러, 레이아웃, 뷰, 앱 상태
src/tui/image.js          이미지 다운로드/디코드 + 하프블록 렌더
src/tui/highlight.js      펜스 코드블록 파서 + 언어별 토크나이저
src/tui/reactions.js      반응 바 선택지 + shortcode 해석
src/tui/clipboard.js      드래그 선택 텍스트 추출 + 클립보드 전달
src/tui/attach.js         드래그 경로 → 첨부 파일 파싱/검증
spoof-proxy/              Go TLS 지문 헬퍼 (기본 사용)
scripts/build-proxy.js    헬퍼 빌드 스크립트
test/                     node:test 기반 오프라인 테스트
docs/REPORT.md            분석/구현 보고서
```

## 참고 자료

- Discord 공식 API 문서: <https://docs.discord.com/developers/>
- Discord Userdoccers: <https://docs.discord.food/>
- `ayn2op/discordo` (Go, GPL-3.0): 기능/헤더 구성 참고. 코드는 복사하지 않았습니다.
- `bogdanfinn/tls-client` (Go, BSD-3-Clause): `--spoof` 헬퍼가 사용하는 TLS
  지문 라이브러리. discordo도 같은 라이브러리를 씁니다.
- `Bios-Marcel/cordless` (Go, 아카이브됨): 과거 TUI 구조 참고.
- 터미널 렌더러/입력 파서는 같은 작성자의 `kakao-linux`(MIT) 구조를 재사용했습니다.

## 라이선스

MIT — [LICENSE](LICENSE) 참고.

이 프로젝트는 Discord Inc.와 제휴하거나 후원받지 않았습니다. "Discord" 및 관련
상표는 Discord Inc.의 소유입니다. 사용자 토큰으로 동작하는 비공식 클라이언트는
Discord 이용약관을 위반할 수 있으며, 계정 제재·토큰 무효화를 포함한 모든 책임은
사용자에게 있습니다. 이 저장소에는 실제 토큰이나 계정 데이터가 포함되어 있지
않으며, 테스트에 쓰이는 값은 모두 합성 데이터입니다.
