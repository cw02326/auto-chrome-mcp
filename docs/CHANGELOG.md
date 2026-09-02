# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v1.10.0] 이전 브랜딩 제거 (2026-09-02)

프로젝트 전반에 남아 있던 이전 브랜딩을 문서 문구부터 동작 식별자까지 모두 걷어냈다.
**네이티브 호스트 이름이 바뀌므로 브리지와 확장을 반드시 함께 1.10.0 으로 올려야 한다.**

### Changed

- **네이티브 메시징 호스트 이름을 `com.autochromemcp.nativehost` 로 바꿨다.** 확장과
  브리지 양쪽이 같은 이름을 써야 연결된다. 한쪽만 올리면 붙지 않는다.
- **런처 CLI 이름이 `auto-chrome-launcher` 다.** bin 래퍼 파일 이름도
  `auto-chrome-launcher.sh` / `.bat` / `.command` 로 바뀌었다. 런처 패키지 이름은
  `auto-chrome-mcp-launcher` 다.
- **Claude Code 트러블슈팅 스킬 이름이 `auto-chrome-mcp-doctor` 다.** 설치 경로는
  `~/.claude/skills/auto-chrome-mcp-doctor/SKILL.md` 이고, 버전 비교에 쓰는 SKILL.md 의
  마커도 `# auto-chrome-mcp-version:` 으로 바뀌었다.
- **스킬 자동 설치 opt-out 환경변수가 `AUTO_CHROME_MCP_NO_SKILL=1` 이다.** 확장 zip
  다운로드를 건너뛰는 변수도 `AUTO_CHROME_MCP_SKIP_EXTENSION_DOWNLOAD=1` 로 바뀌었다.
- **CDP 포트 파일 경로가 `~/.auto-chrome-mcp/cdp-port` 다.** 런처가 쓰고 브리지가 읽는
  파일이라 둘 다 같은 버전이어야 한다. 확장 zip 을 푸는 폴더도
  `~/Downloads/auto-chrome-mcp-extension-v<version>/` 이다.

### Removed

- **하위호환 bin 별칭을 없앴다.** 이전 이름의 bridge / stdio / install 별칭이 더 이상
  설치되지 않는다. 이전 별칭을 스크립트나 `.mcp.json` 에 적어 뒀다면
  `auto-chrome-mcp-bridge`, `auto-chrome-mcp-stdio`, `auto-chrome-mcp-install` 로 고쳐야 한다.

### Migration

- postinstall 이 이전 이름의 흔적을 정리한다(실패해도 설치는 계속된다). 이전 이름의 스킬
  디렉터리를 지우고, 이전 네이티브 호스트 manifest 를 OS 별 NativeMessagingHosts 에서
  지운다. Windows 에서는 같은 이름의 HKCU 레지스트리 키도 함께 지운다.

### 업그레이드 절차

1. 브리지를 올린다: `npm install -g auto-chrome-mcp-bridge`
2. 확장도 같은 1.10.0 으로 올린다. postinstall 이 받아 놓은
   `~/Downloads/auto-chrome-mcp-extension-v1.10.0/` 을 chrome://extensions 에서
   **Load unpacked** 로 다시 지정하고 새로고침한다.
3. 문제가 있으면 `auto-chrome-mcp-bridge doctor --fix` 를 돌린다.

## [v1.9.0] — 무간섭 모드 (2026-09-02)

사용자 불만 하나에서 출발했다: "MCP 가 새 크롬 탭을 띄우면 백그라운드에 머물지 않고 실제로
앞에 떠서, 내가 PC 를 쓰는 중에 방해가 된다." 원인은 하나가 아니었다 — 활성화·창 생성 경로가
파일마다 흩어져 각자 다른 조건을 쓰고 있었고, 그중 몇 개는 조건 자체가 없었다.

### Changed

- **작업 창 기본값이 다시 `dedicated` 다.** v1.4.0 에서 `current` 로 바뀐 뒤로 MCP 작업 탭이
  사용자가 쓰는 바로 그 창에 생겼다. v1.9.0 부터는 별도의 "MCP 작업 창" 에 모인다.
  ⚠️ **마이그레이션 — 확정된 저장 키 우선순위**: 신규 키 `mcpWorkWindowMode` > 구버전 키
  `dedicatedWorkWindow` > 기본값 `dedicated`. 즉 **두 키가 모두 없을 때만** 새 기본값이
  적용되고, 저장값은 언제나 새 기본값보다 우선한다. 예전에 토글을 껐던 사용자의 저장값은
  그대로 존중된다 — 팝업의 "무간섭 권장 설정으로 되돌리기" 버튼이 유일한 전환 통로다.
- **작업 창 배치 설정 신설** (`mcpWorkWindowPlacement`, 기본 `minimized`). 전용 작업 창을
  최소화 / 화면 밖 / 보이게 중에서 고른다. 팝업에서 바꿀 수 있다.
- **`chrome_navigate` 의 `width`/`height` 가 더 이상 새 창을 만들지 않는다(의미 변경).**
  이제 작업 탭의 **뷰포트**를 그 크기로 맞춘다(CDP `Emulation.setDeviceMetricsOverride`).
  창이 필요하면 `newWindow:true` 를 명시해야 한다.
- **`docs/TOOLS.md` 의 `background` 기본값 표기를 false → true 로 정정했다.** 실제 런타임은
  v1.6.0 부터 true 였다(백그라운드 작업 모드의 중앙 게이트가 주입). 문서를 믿고
  `background:false` 를 넣으면 활성화 분기가 열렸다.
- **`chrome_switch_tab` 설명**에 "사용자가 명시적으로 요청했을 때만 쓰고, 자동화 단계에서
  작업 대상을 옮기려면 `chrome_set_work_tab` 을 쓰라"를 넣었다. 스키마는 bridge 번들에
  들어가므로 **다음 bridge 발행 전까지는 모델에게 반영되지 않는다.**

### Fixed

- **활성화 경로가 파일마다 달랐다.** `utils/activation-guard.ts` 를 만들어
  `tabs.update({active:true})` · `tabs.create({active:true})` ·
  `windows.update({focused:true})` 를 한곳으로 모았다. 판정은 네 줄이다 — 예외 도구(force) /
  백그라운드 작업 모드 OFF / 대상이 전용 MCP 작업 창 / 그 외는 활성화하지 않는다.
  web-fetcher · console · inject-script · network-capture 2종 · gif-recorder ·
  플로우 재생(openTab/switchTab/rr-utils/nodes) · navigate 의 폴백 두 곳이 전부 이 통로를 쓴다.
  창 생성은 `utils/mcp-window-manager.ts` 의 `createManagedWindow` 하나로 모았다.
- **전용 작업 창이 만들어지면서 포커스를 훔쳤다.** `focused:false` 로 만들어도 창 안에 활성
  탭을 만드는 순간 그 창이 포커스를 가져간다(실측). 생성 직후 300ms·1200ms 에 비포커스를 다시
  걸고, 그래도 우리 창이 포커스를 쥐고 있으면 **사용자 창으로 되돌린다**. 그 사이 사용자가
  다른 창이나 다른 앱으로 옮겨갔으면(`windows.onFocusChanged`) 복귀를 취소한다.
- **`chrome_navigate` 의 최후 폴백이 `background` 인자를 아예 보지 않았다.** 폴백 두 곳 모두
  새 탭을 비활성으로 만들고, 창 생성은 관리자를 거치도록 고쳤다.
- **모드를 바꾼 뒤에도 사용자 창에 남은 옛 작업 탭을 계속 재사용했다.** `dedicated` 모드에서
  전용 창 밖의 작업 탭은 재사용하지 않고 전용 창에 새로 만든다.
- **플로우 재생의 `switchTab` 이 무조건 탭을 앞으로 가져왔다.** 백그라운드 작업 모드가 켜져
  있으면 작업 탭 포인터만 바꾼다. 단계에 `foreground:true` 를 명시한 경우만 예외다.

### 실측으로 확정한 것 (2026-09-02, Windows 11 + 실제 크롬)

- **오프스크린 배치는 크롬이 거부한다.** `windows.update({left:-32000,top:-32000})` 이
  `Invalid value for bounds. Bounds must be at least 50% within visible screen space.` 로 실패한다.
  좌표를 화면 안으로 되돌리는 게 아니라 호출 자체가 예외다. 그래서 `offscreen` 을 고르면
  자동으로 최소화로 대체한다.
- **`windows.create({state:'minimized'})` 의 state 는 무시된다.** 만들어 보면 `normal` 이다.
  배치는 창을 만든 뒤 `windows.update` 로 건다.
- **한 번도 그려진 적 없는 창을 최소화하면 그 창의 CDP `Page.captureScreenshot` 이 영영
  돌아오지 않는다.** `chrome_screenshot` 이 3회 연속 타임아웃했고, 창을 `normal` 로 되돌리는
  순간 밀려 있던 캡처가 완료됐다. 그래서 최소화 전에 **프레임을 1장 강제로 뽑고**(워밍업)
  성공했을 때만 최소화한다. 워밍업이 실패하면 창을 보이는 채로(비포커스) 남긴다 — 창이
  보이는 것보다 캡처가 죽는 쪽이 나쁘다.
- 워밍업 후 최소화한 창에서는 `chrome_screenshot` 뷰포트·전체 페이지·요소가 example.com 과
  news.ycombinator.com 에서 각각 3/3 정상이었다(18장 전부 실제 페이지, 단색 아님).
- **최소화된 창에서는 그 창의 활성 탭만 캡처된다.** 병렬 lane 처럼 탭이 여럿일 때를 위해
  캡처 직전에 전용 작업 창 안에서만 대상 탭을 활성화하도록 보강했다.

자세한 수치와 실기 회귀 결과는 `docs/plans/2026-09-02-no-interference-mode-design.md` 의
"실측 기록" 절과 `docs/REGRESSION_CASES.md` 에 있다.

### 독립 검토(Codex) 지적 반영 — 2026-09-02

병합 전 독립 검토에서 나온 5건을 같은 라운드에서 고쳤다.

- **기존 작업 창 재사용 경로에도 포커스 보호를 건다.** 창을 새로 만들 때만 예약하면 두 번째
  lane, `newTab:true`, 작업 탭이 닫힌 뒤의 재생성부터 보장이 깨졌다. 전용 창에 `active:true`
  탭을 만드는 자리에서 항상 `protectWorkWindowFocus()` 를 부른다.
- **포커스 감시를 창 생성 _전에_ 시작한다.** `beginFocusWatch()` 로 리스너를 먼저 걸고 창이
  만들어진 뒤 `arm()` 한다. 그 사이에 온 이벤트도 판정에 넣는다. 복귀 직전에는
  `windows.getLastFocused()` 로 "지금 포커스가 우리 창에 있다"를 **재검증**하고, await 를
  건널 때마다 취소 여부를 다시 본다.
- **복귀 대상은 "지금 실제로 포커스를 쥔 사용자 창" 만.** 마지막 포커스 창을 그대로 쓰면
  사용자가 이미 크롬 밖(메모장 등)에 있을 때 크롬을 앞으로 끌어내게 된다.
  `getFocusRestoreTargetWindowId()` 를 따로 두고 `focused === true` 인 창만 기록한다.
- **창 id 재사용 오인 방지.** 창 id 만 기억하면 크롬이 그 id 를 다른 창에 재사용했을 때
  사용자 창을 작업 창으로 오인한다. `chrome.storage.session` 에 `{id, createdAt, type, tabIds}`
  표지를 남기고, `isMcpWindow` 가 창 type 과 "우리가 만든 탭이 아직 그 창에 있는지"까지
  대조한다. 어긋나면 기록을 지워 다음 호출이 새 창을 만들게 한다.
- **전수 회귀 테스트를 조이고 인자를 위험 분기로 바꿨다.** 타임아웃을 실패로 처리하고,
  각 도구가 실제로 chrome API 를 건드렸는지(=실행 경로에 들어갔는지) 확인하며, "전용 작업 창"
  판정을 모의객체가 아니라 모듈의 실제 기록으로 한다. 비교 대상도 `TOOL_SCHEMAS` 가 아니라
  실제 레지스트리(`REGISTERED_TOOL_NAMES`)라 광고하지 않는 내부 도구까지 잡는다.
  fixture 는 navigate 를 뺀 전 도구에 **사용자 탭 id + `background:false`** 를 줘,
  도구들이 사용자 탭을 활성화하려 드는 상황을 만들어 놓고 가드가 막는지 본다.

### 알려진 한계 (2026-09-02 실측)

**최소화된 작업 창에 새 탭을 만들 때는 창을 잠깐 되돌린다.** 최소화된 창에 새로 만든 탭은
한 번도 그려지지 않아 그 탭의 CDP 캡처가 영영 돌아오지 않기 때문이다(스크린샷 도구가 멎는다).
되돌릴 때 `windows.update(id, {state:'normal', focused:false, drawAttention:false})` 로 포커스를
억제한다. 실측한 동작은 다음과 같다.

- 포커스 억제 조합 자체는 먹는다: 최소화된 창을 이 인자로 되돌리면 `state:'normal'` +
  `focused:false` 가 된다(에러 없음).
- 다만 **사용자의 최대화 창에 완전히 가려진 창은 렌더러가 프레임을 만들지 않는다.** 그래서
  포커스 없이 되돌리기만 하면 새 탭 워밍업이 실패하고, 그 탭의 캡처가 다시 멎었다(실측).
  그래서 워밍업이 실패하면 **딱 한 번** 창을 앞으로 꺼내(`focused:true`) 다시 워밍업한다.
  이때도 포커스 보호(지연 이중 비포커스 + 사용자 창 복귀)를 새로 걸어 둔다.
  캡처가 죽는 것보다 창이 잠깐 앞에 나오는 편이 낫다는 판단이다.
- 실기 관측 (사용자 창이 포커스를 쥔 상태에서 `newTab:true` 로 새 작업 탭 생성):

  | 항목                          | 전                    | 후                    |
  | ----------------------------- | --------------------- | --------------------- |
  | `windows.getLastFocused().id` | 384623014 (사용자 창) | 384623014 (사용자 창) |
  | 사용자 창 `focused`           | true                  | true                  |
  | 사용자 창 활성 탭             | 384623267             | 384623267             |
  | 작업 창                       | 384623375 minimized   | 384623375 minimized   |

  같은 조작을 포커스 억제만 넣고 워밍업 대체 경로가 없던 빌드에서 했을 때는
  `getLastFocused()` 는 사용자 창으로 유지됐지만 사용자 창의 `focused` 가 true → **false** 로
  떨어졌다(크롬 창 어느 쪽도 포커스를 갖지 않은 상태). 즉 되돌리는 순간의 포커스 이동은
  환경·타이밍에 따라 관측될 수 있다. 관측된 값을 그대로 남긴다.

- 거슬리면 팝업의 **작업 창 배치** 를 "보이게" 로 바꾸면 창을 되돌리는 동작 자체가 없어진다.

### Tests

확장 vitest 55파일/815건 → **57파일/847건**, 브리지 jest 7스위트/35건(변동 없음).
신규는 `tests/utils/no-interference-mode.test.ts`(21건: 배치·지연 비포커스·복귀 취소·
뷰포트 에뮬레이션·폴백·설정 기본값·가드 규칙)와
`tests/utils/no-interference-tool-sweep.test.ts`(2건: 등록된 비예외 도구 40개를 대표 인자로
한 번씩 돌려 전용 창 밖 활성화·강제 포커스가 0건인지 확인 + fixture 와 도구 레지스트리 일치).

### lint 게이트 (같은 릴리스에 병합)

v1.8.0 "남은 부채"에 적혀 있던 `app/chrome-extension` lint 에러 4건을 정리하고 CI 게이트로 추가했다.

- **`PropertyFormRenderer.vue` 의 prop 직접 변경 3건.** `node` prop 의 `config` 를
  `applyDefaults()` 와 `watch(model, ...)` 에서 직접 대입하고 있었다. 같은 디렉터리의
  `Property*.vue` 27개 파일이 전부 `node` prop 을 라이브 참조로 다루며
  `/* eslint-disable vue/no-mutating-props */` 를 스크립트 최상단에 두는 컨벤션을 따르고
  있어서(이미 각 파일에서 "Unused eslint-disable directive" 경고로 확인됨), 이 파일만
  그 disable 주석이 빠져 있었던 것으로 판단했다. emit 기반으로 새로 리팩터링하지 않고
  같은 컨벤션을 그대로 적용해 동작을 바꾸지 않았다. 호출부는 `PropertyFromSpec.vue`
  한 곳뿐이며 `:node="node"` 로 같은 참조를 그대로 넘기므로 계약에 변화가 없다.
- **`Diagnostic.vue` 의 `vue/multi-word-component-names`.** 이 규칙을 disable 하는
  선례가 저장소에 없어(전수 grep 결과 0건), 규칙을 끄는 대신 `DiagnosticReport.vue` 로
  파일명·컴포넌트 임포트·태그명을 함께 개명했다. 유일한 사용처인
  `entrypoints/popup/App.vue` 의 import 문과 `<Diagnostic .../>` 태그를 함께 갱신했다.
- **CI 게이트.** `.github/workflows/self-test.yml` 에 `Lint (extension)` 스텝
  (`pnpm --filter auto-chrome-mcp-extension lint`) 을 빌드 스텝들 뒤, vitest 스텝 앞에
  추가해 extension 패키지 lint 에러를 CI 실패로 게이트한다. `packages/shared` ·
  `app/native-server` 의 lint 는 이번 범위 밖이라 아직 게이트하지 않았다.
- **검증.** 수정 전 `pnpm --filter auto-chrome-mcp-extension lint` → 4 errors, 56
  warnings(둘 다 기존 그대로 유지, exit 1). 수정 후 → 0 errors, 56 warnings(exit 0).
  vitest 는 수정 전/후 모두 55 files / 815 tests 전부 통과(문서의 기존 베이스라인과 일치) —
  회귀 없음.

## [v1.8.0] — 조용히 새던 것들 (2026-08-25)

v1.7.0 배포 직후 코드를 다시 훑어 나온 결함들이다. 하나같이 "에러가 안 나서 몰랐던" 종류다 —
그림이 안 오고, 컨텍스트가 새고, 탭이 막히고, 정작 CI 는 한 번도 돈 적이 없었다.

### Fixed

- **`chrome_batch` 가 스텝의 이미지를 통째로 버렸다.** 결과를 모을 때 text content 만
  이어붙였다. 정작 스키마 설명은 `click → fill → click → screenshot` 체인을 권한다 —
  배치로 스크린샷을 찍으면 그림이 영영 안 돌아왔다. 이제 스텝이 만든 이미지를 요약 JSON
  뒤에 순서대로 붙인다(어느 스텝에서 나왔는지 `attachedImages` 로 표시). 20 스텝이 전부
  스크린샷일 때를 대비해 뒤에서부터 4장만 남기고, 버린 수를 `droppedImages` 로 알린다.
  실패 스텝의 이미지(게이트가 붙인 실패 스크린샷)도 함께 살린다.
- **멎은 탭이 그 탭을 영구히 막았다.** `chrome.tabs.sendMessage` 는 상대가 `sendResponse`
  를 영영 안 부르면 pending 인 채로 남는다(헬퍼가 비동기 예외로 죽거나 페이지가 멎었을 때).
  탭 단위 직렬화는 "앞선 호출은 반드시 끝난다" 를 전제하므로, 그 탭의 이후 호출이 전부 뒤에
  줄을 서서 영원히 대기했다. 두 겹으로 막았다 — content script 응답 상한 60초(원인과 복구
  방법이 적힌 에러), 그리고 도구 실행 워치독(기본 120초, 도구별 상향, 호출자가 선언한
  대기 시간이 더 길면 그에 맞춰 확장). 워치독은 락을 풀어 다음 호출이 막히지 않게 한다.
- **`chrome_get_web_content` 의 HTML 경로에 길이 상한이 없었다.** 텍스트 경로에는 상한
  100k · reader 추출 · diff 가 다 있었는데 HTML 만 `document.documentElement.outerHTML` 을
  그대로 실어 보냈다 — 무거운 페이지 한 번에 수 MB 가 모델 컨텍스트로 들어갔다. 기본 100k
  상한을 두고(`maxChars` 로 조정), 잘렸으면 `truncated` · `fullHtmlChars` · `returnedChars`
  로 알린다. 텍스트에만 있던 diff 도 HTML 에 붙여, 안 바뀐 페이지를 다시 읽으면
  `{unchanged:true}` 로 끝난다(텍스트/HTML 은 별도 키로 추적).
- **도구가 예외를 던지면 실패 진단이 통째로 빠졌다.** `catch` 가 맨 에러 문자열만 돌려줘,
  정작 가장 알고 싶은 실패에서 단서가 제일 적었다. 이제 사라진 탭 안내(`target_tab_missing`)
  와 실패 스크린샷이 에러 결과와 예외 **둘 다**에 붙는다. 그 진단 자체도 5초에서 끊는다 —
  멎은 렌더러에서는 `Page.captureScreenshot` 도 안 돌아오기 때문이다.
- **죽은 탭을 가리키면 조용히 사용자 탭이 대상이 됐다.** 도구 25개가
  `tryGetTab(args.tabId) || getActiveTab...` 패턴을 공유한다 — 명시한 탭이 이미 닫혔으면
  null 이 떨어지고 그대로 활성 탭으로 흘러간다. 실브라우저 검증 중 실제로 터졌다:
  작업 탭이 닫힌 뒤 같은 tabId 로 `chrome_screenshot` 을 불렀더니 에러 대신 **사용자가 보고
  있던 유튜브 탭이 찍혀** 돌아왔다. `chrome_navigate(refresh:true)` 였다면 사용자 페이지를
  새로고침했을 것이다 — 백그라운드 작업 모드의 무간섭 원칙이 정확히 여기서 깨졌다.
  25곳을 각자 고치는 대신 게이트에서 한 번 막는다(`utils/target-tab-guard.ts`): 명시된
  tabId 가 없으면 도구를 돌리기 전에 끊고 `target_tab_missing` 안내를 준다.
- **같은 탭에 CDP attach 가 동시에 들어오면 하나가 죽었다.** attach 는 `getTargets` 와
  `debugger.attach` 사이에 await 를 건넌다. 둘이 동시에 "아무도 안 붙어 있다" 를 보고 각자
  붙으러 가서, 하나가 `Another debugger is already attached` 로 실패하고 refCount 도
  덮어써져 샜다(병렬 레인 + 스크린샷/네트워크 캡처 조합에서 간헐 실패). 탭별로 직렬화했다.

### Changed

- **`self-test` CI 가 한 번도 돈 적이 없었다.** 트리거가 이전 브랜치와 `master` 인데
  이 fork 의 기본 브랜치는 `main` 이다 — `gh run list` 에 self-test 기록이 전무하다.
  브랜치를 고치고, 어떤 패키지와도 안 맞던 필터를 실제 패키지 이름(`auto-chrome-mcp-bridge`)
  으로 바로잡고, **CI 에 아예 없던 vitest 회귀 809건을 추가**했다.
  그동안 게이트를 통과한 건 jest 35건뿐이었다.
- **`build-release.yml` 은 전체가 주석이었다** (유효한 스텝 0줄). GitHub 이 이걸 유효하지
  않은 워크플로로 보고 **main 에 푸시할 때마다 실패로 기록**했다 — 최근 커밋의 빨간불이
  전부 이것이다. 파일을 지웠다.
- `chrome_get_web_content` 설명을 실제 동작에 맞게 다시 썼다(upstream 의
  `'Fetch content from a web page'` 그대로였다). reader 기본 · diff · 상한 보고를 알리고,
  좁은 추출은 `chrome_extract`, 클릭 대상 찾기는 `chrome_read_page` 로 유도한다.
- **로컬 `npx eslint .` 이 빌드만 하면 못 쓰게 됐다.** flat config 의 무접두 무시 패턴은
  설정 파일 위치 기준이라 `'dist/'`·`'.output/'` 이 워크스페이스 하위를 못 걸렀다. 한 번
  빌드하고 나면 산출물에서만 9,637건이 쏟아져 실제 신호가 완전히 묻혔다(벤더 번들
  `public/libs/ort.min.js` 와 `commitlint.config.cjs` 까지 더해 총 554건이 더 남아 있었다).
  `**/` 접두로 고치고 벤더·설정 파일을 뺐다 — 이제 빌드 후에도 루트 lint 가 깨끗하다.
- 매 도구 호출마다 작업 탭을 두 번 조회하던 것을 한 번으로 줄였다(게이트가 구한 값을
  재사용) — 호출당 `chrome.storage.session` 쓰기가 절반이 된다.

### Tests

- 회귀 32건 추가 (extension vitest 783 → **815**, native-server jest 35 유지).
  `tool-watchdog` 8 · `web-fetcher-html-cap` 6 · `target-tab-guard` 6 · `batch-images` 5 ·
  `tab-message-timeout` 4 · `cdp-attach-race` 3. 핵심 회귀는 **"영원히 안 끝나는 도구가
  탭 락을 영구 점유하지 못한다"**, **"batch 가 스텝의 스크린샷을 돌려준다"**,
  **"죽은 탭을 가리킨 호출이 사용자 탭으로 새지 않는다"** 다.
- 게이트(`handleCallTool`) · `tab-lock` · `batch` · CDP 세션 관리는 그동안 단위 테스트가
  **하나도 없었다**. 테스트 49개 중 대부분이 upstream 의 record-replay·web-editor 였다.

### 검증

- 자동 회귀: vitest 815/815, jest 35/35.
- 실브라우저(확장 리로드 후 실측):
  ① batch 가 스텝 스크린샷을 실제로 반환 (`images:1` + `attachedImages`) — 고치기 전엔 0장.
  ② `maxChars` 가 helper 까지 전달돼 `returnedChars:150` · `truncated:true` ·
  `fullHtmlChars:443` · 안내 문구까지 정확.
  ③ 죽은 tabId 로 `chrome_screenshot` 호출 → 사용자 탭이 찍히는 대신
  `Tab not found` + `target_tab_missing` 으로 끊김. **이 버그 자체가 이 검증에서 나왔다.**
  ④ 실패한 `chrome_read_page` 의 실패 스크린샷이 batch 결과까지 살아서 전달됨
  (실패 진단 + batch 이미지 두 수정이 함께 동작).
  ⑤ 정상 경로 무손상: 레인 작업 탭 재사용(`reusedWorkTab:true`), `chrome_read_page` 정상.
- 재현 못 한 것: 무한 대기 자체는 실브라우저에서 유도하지 못했다. 메인 스레드를 90초
  점유해 봤지만 크롬이 pending 대신 즉시 에러를 냈다. 워치독·응답 상한이 노리는 건
  "헬퍼가 메시지를 받고 sendResponse 를 영영 안 부르는" 경우이고, 그건 단위 테스트로만
  덮여 있다.

> ⚠️ `chrome_get_web_content` 에 `maxChars` 가 새로 생기고 여러 도구 설명이 바뀌었다.
> 이 스키마를 쓰려면 **전역 bridge 갱신(`npm i -g auto-chrome-mcp-bridge`) + 확장 리로드 +
> Claude Code 세션 재시작**이 필요하다. 셋 다 하기 전에도 나머지 수정(batch 이미지 · 죽은 탭
> 가드 · 워치독 · HTML 기본 상한)은 **확장 리로드만으로** 그대로 동작한다 — 그 넷은 확장 쪽
> 코드이기 때문이다.

### 남은 부채

- `vue-tsc --noEmit` 이 **134건 실패**한다(전부 upstream `record-replay-v3`·
  `element-marker`·그 테스트 파일). `pnpm compile` 은 사실상 못 쓰는 상태이고 CI 게이트도
  없다. 이번엔 손대지 않았다 — 우리가 만진 파일에서는 0건.
- 확장 패키지 자체의 lint(`app/chrome-extension` 설정)에는 에러 4건이 남아 있다(upstream 빌더 UI `PropertyFormRenderer.vue` 의 prop 직접 변경
  3건 — 그 기능은 팝업에서 비활성 — 과 `Diagnostic.vue` 컴포넌트 이름 규칙). 첫날부터
  빨간 게이트를 만들지 않으려고 lint 는 CI 에 아직 안 넣었다.
- `chrome_read_page` 가 요소가 극히 적은 페이지(example.com 수준)에서
  `Accessibility tree is too sparse and fallback failed` 로 실패한다. 기존 동작이고 이번
  변경과 무관하지만(위키피디아 등 일반 페이지는 정상), 휴리스틱을 손볼 여지가 있다.
- 세 패키지의 `lint` 스크립트가 윈도우에서 안 돈다(작은따옴표 glob 을 셸이 안 펼친다).
  리눅스 CI 에서는 정상.

## [v1.7.0] — 병렬 에이전트가 서로를 죽이지 않는다 (2026-08-23)

사용자 보고에서 출발했다: "에이전트 4개를 띄웠더니 전원 `tab_not_found` 로 중단됐다.
`chrome_set_work_tab` 으로 보호해도 서로 덮어쓴다." 원인은 두 겹이었다.

1. 한 Claude Code 세션의 **서브에이전트는 stdio 프로세스를 공유**한다 — 확장 입장에선
   `_mcpSessionId` 가 전부 같아 넷이 한 세션으로 보인다. 세션당 작업 탭이 하나뿐이었으니
   서로의 작업 탭을 계속 덮어썼다.
2. v1.6.0 의 "새 작업 탭이 열리면 같은 세션의 유휴 탭을 닫는다" 정리가, `isTabBusy` 가
   **도구 실행 중일 때만** true 인 탓에 형제 탭을 유휴로 오인해 차례로 닫았다.

### Added

- **`lane` 인자 (병렬 작업 레인)**: 탭을 다루는 도구 33개에 선택적 `lane` 문자열이 붙었다.
  레인을 주면 같은 stdio 세션 안에서도 작업 탭 버킷이 갈라져, 에이전트마다 자기 작업 탭을
  갖는다. 다른 레인은 그 탭을 재지정할 수도, 정리로 닫을 수도 없다. `chrome_batch` /
  `chrome_shortcut` 은 step 마다 레인을 자동으로 물려준다. 단일 작업이면 안 써도 된다 —
  생략 시 동작은 이전과 같다.
- **`target_tab_missing` 안내**: 대상 탭이 사라져 실패하면 왜 사라졌는지(MCP 정리 / 사용자
  닫음)와 복구 방법을 결과에 싣는다. 같은 `tabId` 로 무한 재시도하다 죽는 흐름을 끊는다.

### Changed

- **탭 정리 기준을 다시 설계**: "실행 중이 아니면 닫는다" → 세 겹 판정.
  ① 절대 안 닫음(방금 만든 탭 / 실행 중 / 어느 레인이든 현재 작업 탭 / 사용자가 보는 탭)
  ② 90초 유예 안에 쓰인 탭은 남김 ③ 그러고도 남는 여분이 레인당 8개를 넘으면 오래된 순 정리.
  15분 넘게 안 쓰인 탭은 레인을 가리지 않고 회수해, 사라진 에이전트의 탭이 남지 않게 했다.
- **automation guard 버킷도 레인 단위**로 쪼갰다. 같은 일을 하는 병렬 에이전트들이 서로의
  반복 카운터를 밀어 "runaway loop" 로 오판되던 문제가 사라진다.
- 작업 탭 버킷 상한을 10 → 32 로 올렸다 (한 세션이 여러 레인을 쓰므로).

### 검증

세 겹으로 확인했다.

1. **자동 회귀** — extension vitest 783건 / native-server jest 35건 통과. 새 회귀 18건이
   `tests/utils/work-tab-parallel.test.ts` · `tool-schema-lane.test.ts` 와 automation-guard 에
   들어갔고, 핵심은 **레인이 다른 병렬 에이전트 4개의 작업 탭이 모두 살아남는다** 이다.
2. **실브라우저 병렬** — 에이전트 4개 동시 실행에서 MCP 탭 8개 전량 생존, `tab_not_found` 0건.
   `mcpWorkTabSessions` 가 `stdio-<pid>-xxxxxx::agent-1..4` 로 찍혀, "서브에이전트는 stdio
   세션을 공유한다" 는 전제를 실측으로 확인했다. 자세한 내용은 `docs/REGRESSION_CASES.md`.
3. **배포물 E2E** — 발행된 bridge 를 Claude Code 없이 직접 띄워 MCP 프로토콜로 검증(6/6):
   `tools/list` 가 lane 을 33개 도구에 광고하고 어디서도 required 가 아니며, lane 을 실은
   navigate 가 연 탭이 해당 레인의 작업 탭으로 기록되고, 그 탭만 정확히 닫혔다.

> ⚠️ 도구 스키마가 바뀌었으므로 `lane` 을 쓰려면 **Claude Code 세션을 재시작**해야 한다
> (확장 리로드 + 전역 bridge 갱신 후).

### 발행 과정에서 드러난 CI 결함 2건 (같은 릴리스에서 수정)

태그를 밀고 나서 두 번 실패했다. 둘 다 **레지스트리 거부 단계**라 npm 에 반쪽 발행물이 올라간
적은 없고, `v1.7.0` 번호도 태우지 않고 태그를 다시 만들어 재사용했다.

- **`npm publish` 인자가 GitHub 단축 표기로 해석됐다** (`EALLOWGIT`). 워크플로가 매번
  `npm@latest` 를 까는데 러너의 npm 이 12.0.2 였고, npm 12 부터 git 타입 fetch 가 기본 차단이라
  `dist-tarballs/foo.tgz` 가 `owner/repo` 로 읽혔다. 경로 앞에 `./` 를 붙여 고쳤다.
- **provenance 검증에서 거부됐다** (`E422`). trusted publishing 이 붙인 provenance 와 패키지
  자신의 `repository.url` 을 레지스트리가 대조하는데, `packages/shared/package.json` 에 그 필드가
  아예 없었다(bridge·루트에는 있었다). 필드를 채워 고쳤다.

⚠️ **리허설(`gh workflow run release.yml`)로는 위 둘을 잡을 수 없다** — 발행 스텝이
`if: github.event_name == 'push'` 라 수동 실행에서는 통째로 건너뛴다. 리허설 통과는 "빌드·테스트·
팩까지 성하다" 는 뜻이지 "발행이 된다" 는 보장이 아니다.

## [v1.6.0] — 백그라운드 탭에서도 제대로 도는 자동화 (2026-08-23)

사용자 증상 하나에서 출발했다: "백그라운드 탭에서 무한 스크롤이 20개쯤에서 멈추고 푸터가
뜬다 — 크롬인크롬은 되는데." 원인은 크롬이 **비활성 탭의 렌더링 프레임을 만들지 않는 것**
이었고, 파고드는 과정에서 로딩 대기·스냅샷 병합의 결함까지 함께 드러났다.

### Added

- **백그라운드 탭 렌더링 유지** (`chrome_scroll_collect` 의 `renderMode`): 비활성 탭은
  `requestAnimationFrame` 이 멈춰 무한 스크롤이 의존하는 `IntersectionObserver` 가 영영
  발화하지 않는다. CDP 로 주기적으로 프레임을 강제해(250ms 간격) 탭을 앞으로 끌어내지
  않고도 지연 로딩이 정상 동작한다. `auto`(기본, 탭이 안 보일 때만) / `force` / `off`.
  결과에 실제로 적용된 수단을 `renderAssist` 로 싣고, 살리지 못한 채 멈추면
  `stoppedReason` 을 `noGrowthWhileHidden` 으로 정정한다(바닥 도달로 오보고하지 않는다).
- **작업 탭 재사용·정리**: 이 세션이 만든 작업 탭이 **유휴일 때만** 재사용하고, 새 작업
  탭이 열리면 같은 세션의 유휴 탭을 닫는다. 탭이 무한히 쌓이지 않으면서 병렬 작업은
  서로의 페이지를 덮어쓰지 않는다. `chrome_navigate` 의 `newTab:true` 로 강제할 수 있고,
  사용자가 `chrome_set_work_tab` 으로 지정한 탭은 절대 끌려가지 않는다.
- **"Claude 작업 중" 표시**: 작업 탭 페이지에 보라색 테두리와 배지를 띄운다. shadow DOM 이라
  사이트 CSS·텍스트 수집과 섞이지 않고, `pointer-events:none` 이라 클릭을 막지 않는다.

### Fixed

- **렌더링 유지가 실제로는 동작하지 않았다**: `Page.startScreencast` 는 "생산된 프레임을
  받아 가는" 수동적 장치라, 프레임이 아예 안 나오는 숨은 탭에서는 첫 프레임이 영원히 오지
  않는다(실측: force 모드 15초에 페이지 rAF 0회). 프레임 생산을 강제하는
  `Page.captureScreenshot` 을 주기적으로 눌러 주는 방식으로 교체했다. 실측 결과 같은
  페이지에서 10개 → 100개 전량 수집.
- **`chrome_navigate` 의 `waitUntil` 이 무력했다**: 내비게이션이 커밋되기 전에는 이전
  문서가 살아 있고 `readyState` 가 `complete` 라, 대기가 1~7ms 만에 끝나고 결과의
  url·title 도 이전 페이지 것이 나갔다. 이동을 걸기 **전에** 시작 신호를 잡고, 문서
  식별자·탭 상태·목표 URL 커밋 여부로 판정한다. 탭이 닫히면 즉시 `tab_not_found`,
  주입할 수 없는 문서(about:blank·PDF)는 탭 상태로 판정해(`not_injectable`) 타임아웃까지
  헛돌지 않는다.
- **`waitUntil:'none'` 이 탭 점유를 풀지 않았다**: 재사용 탭이 영원히 busy 로 남아 이후
  호출이 새 탭만 계속 만들었다.
- **`chrome_scroll_collect` 텍스트가 패스마다 페이지 전체를 중복 누적했다**: 푸터나 로딩
  스피너 때문에 새 항목이 가운데로 들어오면 접두·접미 겹침이 둘 다 빗나갔다(실측: 최종
  16.8KB 페이지가 120KB). 줄 단위 정렬로 다시 짜서 같은 페이지가 16.9KB 로 수렴한다.

### Changed

- `docs/TOOLS.md` 를 실제 도구 41개에 맞춰 동기화했다(문서에는 21개만 있었고 그중 6개는
  이미 없어진 도구였다). 공통 파라미터를 한 절로 뽑고, Performance·Automation 섹션을 추가.

### Tests

- 이 영역들에는 단위 테스트가 없었다 — 그래서 깨진 채로 배포됐다. 56건을 추가했고,
  그중 24건은 무한 스크롤 페이지 모양 4종 × 시드 3개 × 페이지 크기 2종을 돌려 매 패스마다
  "손실 0 · 중복 0 · 크기 폭발 없음" 을 확인하는 퍼즈 테스트다. 확장 762건 + 브리지 25건 통과.

## [v1.5.0] - 상호작용 안정화 + 신규 도구 4종 (2026-08-20)

### Added - 안정화 (A1~A3)

- **클릭/입력 요소 대기 내장** (`waitForElementMs`, 기본 2000ms): `chrome_click_element` /
  `chrome_fill_or_select` 가 대상 요소가 아직 렌더되지 않았을 때 즉시 실패하지 않고
  짧게 폴링한다. 요소를 찾은 뒤에는 남은 시간 동안 "보이는 상태"가 되기를 기다린다
  (등장 애니메이션·오버레이가 걷히는 경우). SPA 에서 반복되던
  `클릭 실패 -> chrome_wait_for -> 재클릭` 3회 왕복이 1회로 줄어든다. `0` 이면 종전처럼 즉시 실패.
- **`chrome_navigate` 로딩 완료 대기** (`waitUntil`, 기본 `domcontentloaded`):
  이동 직후 `read_page` / `click` 이 빈 페이지를 보던 문제를 없앤다.
  `none` / `domcontentloaded` / `load` / `networkidle` 중 선택하며, 관측된 로드 상태는
  결과의 `load` 필드로 돌아온다 (타임아웃은 오류가 아니라 관측 결과로 보고). 대기 후의
  최종 URL/제목으로 결과를 갱신하므로 리다이렉트도 반영된다.
- **클릭 실패 원인 보고 (`obstruction`)**: 클릭이 "가려져서" 실패하면 무엇이 가리는지
  함께 돌려준다 - 가리는 요소(태그/id/class/텍스트/z-index/좌표), 모달로 볼 만한 조상
  (`<dialog open>` / `role=dialog` / `aria-modal` / 높은 z-index 의 레이어), 뷰포트 점유율,
  body 스크롤 잠금 여부, 그리고 다음 행동 힌트. 기존에는 `elementFromPoint` 로 가리는 요소를
  알아내고도 버려서 모델이 같은 클릭을 반복했다. 가시성 외의 실패도 구분해 보고한다
  (`hidden_by_css` / `transparent` / `zero_size` / `outside_viewport`).
  `ref` 로 클릭한 경우에는 요소에 직접 이벤트를 쏘므로 클릭 자체는 성공하지만, 가려진
  상태였다면 결과에 경고를 붙인다 (사이트가 무시했을 수 있음).

### Added - 신규 도구 (B1~B4)

- **`chrome_storage`**: 쿠키 / localStorage / sessionStorage 조회·설정·삭제. 로그인 세션
  저장·복원, 로그아웃 상태 테스트, 동의 쿠키 미리 심기, 프론트엔드 상태 디버깅에 쓴다.
  값은 기본적으로 마스킹해서 돌려주고(`includeValues:true` 로만 노출), `clear` 는 범위
  (url 또는 domain)를 반드시 요구해 브라우저 전체 쿠키가 날아가는 것을 막는다.
  manifest 에 `cookies` 권한 추가.
- **`chrome_save_pdf`**: 현재 페이지를 PDF 로 저장 (CDP `Page.printToPDF`).
  스크린샷과 달리 텍스트가 살아 있고 여러 페이지를 온전히 담아 공고문·계약서·리포트
  보관에 맞다. 용지/방향/배율/여백/페이지 범위 지정 가능. base64 는 반환하지 않고
  `Downloads/mcp-pdf/` 에 저장한 뒤 파일명만 돌려준다 (토큰 폭증 방지).
- **`chrome_emulate`**: 디바이스 뷰포트 에뮬레이션 (크기/픽셀 밀도/터치/User-Agent).
  프리셋 7종(iphone-se, iphone-15, pixel-8, galaxy-s23, ipad, desktop-1280, desktop-1080p)
  또는 직접 지정. 실제 창 크기를 바꾸지 않으므로 백그라운드 작업 탭에서도 동작한다.
  `set` 은 CDP 세션을 유지하고 `reset` 에서 해제한다 (탭이 닫히면 자동 정리).
- **`chrome_network_rules`**: declarativeNetRequest 세션 규칙으로 요청 차단.
  선언만 해두고 쓰이지 않던 권한을 실제 기능으로 만들었다. 프리셋(ads / trackers /
  images / media / fonts) 또는 커스텀 urlFilter 패턴. 탭 단위 적용 가능, 브라우저 재시작 시
  자동 소멸. 광고·추적을 막으면 페이지 로드가 빨라지고 `read_page` 가 읽는 잡동사니가 줄어
  토큰도 절약된다. 규칙 id 는 9000-9899 대역만 사용해 다른 세션 규칙과 섞이지 않는다.

### Changed

- `sendMessageToTab` 이 content script 의 오류 응답 전체를 `Error.response` 에 실어 보낸다.
  이전에는 메시지 문자열만 남기고 `elementInfo` / `obstruction` 같은 진단 정보를 버렸다.

## [v1.4.2] — 발행 수정 (2026-08-18)

### Fixed

- **v1.4.0 / v1.4.1 은 npm 에서 설치할 수 없다.** 모노레포 내부 의존성
  `auto-chrome-mcp-shared: "workspace:*"` 가 치환되지 않은 채 발행돼
  `npm install -g` 이 `EUNSUPPORTEDPROTOCOL: Unsupported URL Type "workspace:"` 로 실패한다.
  `npm publish` 로 올렸기 때문 — **workspace 프로토콜을 실제 버전으로 바꿔주는 것은 pnpm 뿐이다.**
  v1.4.2 는 `pnpm publish` 로 올렸고, 발행 전 `pnpm pack` 으로 tarball 안의
  dependencies 를 확인했다.
- 깨진 1.4.0 / 1.4.1 은 deprecate 처리했다.

### 릴리스 절차 (재발 방지)

1. 버전 올리기 (4개 package.json)
2. `pnpm --filter ... build` 로 전체 빌드
3. **`pnpm pack` 으로 tarball 의 `dependencies` 에 `workspace:` 가 남아있지 않은지 확인**
4. `pnpm publish` 로 발행 (`npm publish` 금지)

## [v1.4.1] — 이중 응답 수정 (2026-08-18)

### Fixed

- **`ERR_HTTP_HEADERS_SENT` 대량 발생**: MCP transport 가 `reply.raw` 에 직접 응답을 쓰는데
  Fastify 는 그것을 모른 채 핸들러 종료 후 자체 응답을 한 번 더 보내고 있었다. 결과적으로
  요청 한 건마다 stderr 에 스택이 쌓였다. `/mcp` POST·GET·DELETE, `/sse`, `/messages` 전부
  transport 에 `reply.raw` 를 넘기기 **전에** `reply.hijack()` 하도록 고쳤다.
- 기존 에러 처리의 `if (!reply.sent)` 가드는 raw 쓰기를 반영하지 않아 무력했다. hijack 이후
  상태를 볼 수 있는 `reply.raw.headersSent` / `writableEnded` 기준으로 바꾸고 공용 헬퍼
  `endRawWithError` 로 정리했다.
- GET `/mcp` 는 헤더를 flush 한 뒤에야 hijack 하고 있었다. 순서를 바로잡았다.

MCP 클라이언트를 둘 이상(Claude Code + Codex) 동시에 붙이면서 드러난 문제다. jest 25 통과.

## [v1.4.0] — 현재 창 작업 탭 (2026-08-18)

### Changed — MCP 작업 탭 기본 위치

- **작업 탭이 별도 창이 아니라 사용자가 열어 둔 현재 창에 열린다.** 설정이
  `dedicatedWorkWindow`(boolean) → `mcpWorkWindowMode`(`current` | `dedicated`) 로 바뀌고
  기본값은 `current`. 구버전 boolean 설정은 자동 승계된다.
- `current` 모드의 탭은 항상 비활성(`active: false`)으로 생성 — 사용자가 보던 탭을
  뺏지 않는다. 스크린샷·read_page 는 CDP 경로라 보이지 않는 탭에서도 동작한다.
- 대상 창은 열린 창 중 type `normal` 만 후보로 삼는다 (팝업·개발자도구·앱 창, 시크릿 창,
  이전에 만든 전용 작업 창 제외). 적격 창이 없으면 종전처럼 새 창을 만든다.
- 전용 작업 창은 팝업 토글로 계속 쓸 수 있다 (기본 OFF).

### Fixed

- **사용자 탭 하이재킹**: 같은 URL 재사용 후보에서 사용자 탭을 빼는 필터가 전용 작업 창이
  켜져 있을 때만 걸려 있었다. 토글을 끄면 MCP 가 사용자가 열어 둔 탭을 잡아 조작했다.
  이제 백그라운드 작업 모드면 창 모드와 무관하게 항상 적용된다.
- **doctor 가 남의 npm 패키지 설치를 안내하던 문제**: 복구 명령의 패키지명이
  이전 패키지 이름이었다. 그 이름은 npm 에서 타 계정 소유다.
  실제 패키지명 `auto-chrome-mcp-bridge` 로 정정했다.
- **postinstall 안내의 잘못된 경로**: 이전 패키지 이름의 경로로
  안내했으나 실제 설치 폴더는 `auto-chrome-mcp-bridge` 다. 아울러 프로젝트별 `.mcp.json`
  대신 `claude mcp add -s user` 전역 등록을 안내하도록 바꿨다 (프로젝트마다 넣으면
  경로가 어긋나 깨지기 쉽다).
- doctor 의 bridge 프로세스 탐지가 구 폴더명만 찾던 것을 두 이름 모두 인정하도록 수정.

### Chore

- 주석·문서의 이전 브랜딩 표기를 `auto-chrome-mcp` 로 정리 (95개 파일). 네이티브 호스트
  id, npm 패키지명·bin 별칭, 워크스페이스 package.json name, doctor 스킬명, 런타임 데이터
  폴더는 기존 설치 호환을 위해 그대로 뒀다.

## [v1.3.0] — Auto Chrome MCP (2026-08-17)

### Added — Claude-in-Chrome 격차 해소 (사용자 선택 1–3)

- **`chrome_find`**: natural-language element search (Korean/English) over the accessibility tree — synonym + fuzzy scoring, iframe search included; returns ranked refs/coordinates/frameId usable directly with click/fill/computer.
- **Multi-browser switching** (stdio-local tools, never forwarded to the extension): `chrome_list_browsers` probes candidate bridge ports (active + `CHROME_PORTS` env + defaults) via GET /ping; `chrome_use_browser` switches the session's active browser profile mid-session with clean session termination on the old bridge.
- **`chrome_shortcut`**: named saved macros (chrome_batch step format) — save/run/list/delete, stored in extension storage, executed through the normal tool gate (session work tabs, guards, locks all apply).

## [v1.2.0] — Auto Chrome MCP (2026-08-17)

### Added — 팝업 인지 · 신뢰성 (F1–F7)

- **Popup/new-tab awareness**: tool calls that spawn new tabs/popup windows (OAuth logins, target=\_blank) now report `new_tabs_opened` in the result; new `chrome_set_work_tab` retargets the session work tab without focusing anything; `get_windows_and_tabs` marks work tabs, the MCP window, and recently spawned tabs.
- **`chrome_wait_for`**: wait for selector/text/document-ready/network-idle before acting (timeout returns observed state, not an error).
- **Frame-aware interaction**: click/fill auto-search iframes when the selector isn't in the top frame (probe protocol, first-found wins, frameId reported); `read_page`/interactive-elements gain `allFrames`.
- **Failure screenshots**: failed tool calls attach a downscaled JPEG of the target tab (`errorScreenshotOnFailure` to disable).
- **Login-redirect detection**: `login_required_suspected` warning when the target tab lands on a login page mid-call.
- **Download awareness**: downloads started during a call are reported (`downloads_started`).
- **Popup focus return**: popup windows opened by MCP work tabs are blurred so the user's window regains OS focus.
- **`chrome_scroll_collect`**: one-call infinite-scroll content collection (virtualized-list overlap handling included).

### Added — 토큰 절감 (T1–T7, 품질 무손실)

- **Screenshots as MCP image blocks**: `storeBase64` no longer returns base64 inside text (was 100k+ text tokens per shot); images are auto-downscaled to ≤1568px long edge with exact `imageScale` metadata (also fixes a long-standing coordinate-mapping drift on downscaled screenshots); `fullResolution` opt-out. computer zoom had the same leak — fixed.
- **Diff mode** (`diff`, default on): `read_page`/`get_web_content` return `{unchanged:true}` instead of re-sending identical content (ref map stays fresh).
- **`chrome_extract`**: CSS-selector field extraction — return only the values you need instead of full-page reads.
- **Reader mode** (`raw:false` default): `get_web_content` strips nav/footer/cookie/ad boilerplate and no longer dumps full body text when Readability fails.
- **Lossless a11y-tree compaction** (`compact`, default on): 35–50% smaller `read_page` output (wrapper collapse, dedup, notation shortening; refs/roles/states preserved).
- **Pagination**: console/network-capture/history gain `limit`/`offset`/`countOnly`.
- Failure screenshots are downscaled ~40% further.

## [v1.1.0] — auto-chrome-mcp fork (2026-08-17)

### Added — 백그라운드 작업 모드 (non-interference)

- **Background work mode** (`backgroundWorkMode`, default ON, popup toggle "백그라운드 작업"): MCP tools no longer activate tabs or steal focus; all tools default `background: true` via a central gate in `tools/index.ts`.
- **Per-session work tabs** (max 10, LRU): each Claude Code session's stdio proxy injects `_mcpSessionId` into every call; `chrome_navigate` records the session's work tab, and tabId-less tool calls target it instead of the user's active tab. Work tabs show an "MCP" action badge.
- **Dedicated MCP work window** (`dedicatedWorkWindow`, default ON, popup toggle "전용 작업 창"): MCP tabs are created in a separate unfocused window; URL-reuse never grabs tabs from user windows in background mode.
- **`chrome_batch` tool**: run up to 20 tool steps in one MCP round-trip (stop-on-error or continueOnError).
- **Screenshot auto-save**: `saveToDownloads`/`filename` params save captures under `Downloads/mcp-screenshots/`.
- **Automation guard** (`automationGuardEnabled`, default ON): per-domain soft throttle (30 actions/10s, delay ≤5s) and runaway-loop breaker (identical call ×12 in 120s → blocked).
- **Per-tab serialization**: concurrent tool calls targeting the same tab are queued, so two sessions can't interleave input on one tab.
- **`tabId` param added** to dialog / network_request / network_capture / performance×3 / userscript / bookmark_add schemas.

### Fixed

- Screenshots are now CDP-first: background tabs capture correctly (incl. fullPage via `captureBeyondViewport`); the captureVisibleTab fallback errors instead of silently returning the wrong tab.
- `chrome_computer` sub-delegations (screenshot/click/fill/keyboard, 10 call sites) now forward the resolved `tabId`.
- Removed needless `tabs.update({active:true})` in console / inject-script / network-capture / web-fetcher; two raw `windows.update({focused:true})` calls now respect the force-focus policy; record-replay window focus routed through the same policy.
- GIF recording of tabs in non-focused windows activates the tab within its own window (animations keep running) and restores the previous tab afterwards.
- `chrome_console` deep-serializes lossy objects (depth 4, 5000 chars, budgeted CDP calls) instead of returning truncated previews (upstream #215).
- CDP attach conflicts retry once (300ms) and report an actionable error; stale debugger sessions are cleaned on force-detach.
- `chrome_close_tabs` with no args closes the session work tab, never the user's active tab, in background mode.

## [v0.0.5]

### Improved

- **Image Compression**: Compress base64 images when using screenshot tool
- **Interactive Elements Detection Optimization**: Enhanced interactive elements detection tool with expanded search scope, now supports finding interactive div elements

## [v0.0.4]

### Added

- **STDIO Connection Support**: Added support for connecting to the MCP server via standard input/output (stdio) method
- **Console Output Capture Tool**: New `chrome_console` tool for capturing browser console output

## [v0.0.3]

### Added

- **Inject script tool**: For injecting content scripts into web page
- **Send command to inject script tool**: For sending commands to the injected script

## [v0.0.2]

### Added

- **Conditional Semantic Engine Initialization**: Smart cache-based initialization that only loads models when cached versions are available
- **Enhanced Model Cache Management**: Comprehensive cache management system with automatic cleanup and size limits
- **Windows Platform Compatibility**: Full support for Windows Chrome Native Messaging with registry-based manifest detection
- **Cache Statistics and Manual Management**: User interface for viewing cache stats and manual cache cleanup
- **Concurrent Initialization Protection**: Prevents duplicate initialization attempts across components

### Improved

- **Startup Performance**: Dramatically reduced startup time when no model cache exists (from ~3s to ~0.5s)
- **Memory Usage**: Optimized memory consumption through on-demand model loading
- **Cache Expiration Logic**: Intelligent cache expiration (14 days) with automatic cleanup
- **Error Handling**: Enhanced error handling for model initialization failures
- **Component Coordination**: Simplified initialization flow between semantic engine and content indexer

### Fixed

- **Windows Native Host Issues**: Resolved Node.js environment conflicts with multiple NVM installations
- **Race Condition Prevention**: Eliminated concurrent initialization attempts that could cause conflicts
- **Cache Size Management**: Automatic cleanup when cache exceeds 500MB limit
- **Model Download Optimization**: Prevents unnecessary model downloads during plugin startup

### Technical Improvements

- **ModelCacheManager**: Added `isModelCached()` and `hasAnyValidCache()` methods for cache detection
- **SemanticSimilarityEngine**: Added cache checking functions and conditional initialization logic
- **Background Script**: Implemented smart initialization based on cache availability
- **VectorSearchTool**: Simplified to passive initialization model
- **ContentIndexer**: Enhanced with semantic engine readiness checks

### Documentation

- Added comprehensive conditional initialization documentation
- Updated cache management system documentation
- Created troubleshooting guides for Windows platform issues

## [v0.0.1]

### Added

- **Core Browser Tools**: Complete set of browser automation tools for web interaction
  - **Click Tool**: Intelligent element clicking with coordinate and selector support
  - **Fill Tool**: Form filling with text input and selection capabilities
  - **Screenshot Tool**: Full page and element-specific screenshot capture
  - **Navigation Tools**: URL navigation and page interaction utilities
  - **Keyboard Tool**: Keyboard input simulation and hotkey support

- **Vector Search Engine**: Advanced semantic search capabilities
  - **Content Indexing**: Automatic indexing of browser tab content
  - **Semantic Similarity**: AI-powered text similarity matching
  - **Vector Database**: Efficient storage and retrieval of embeddings
  - **Multi-language Support**: Comprehensive multilingual text processing

- **Native Host Integration**: Seamless communication with external applications
  - **Chrome Native Messaging**: Bidirectional communication channel
  - **Cross-platform Support**: Windows, macOS, and Linux compatibility
  - **Message Protocol**: Structured messaging system for tool execution

- **AI Model Integration**: State-of-the-art language models for semantic processing
  - **Transformer Models**: Support for multiple pre-trained models
  - **ONNX Runtime**: Optimized model inference with WebAssembly
  - **Model Management**: Dynamic model loading and switching
  - **Performance Optimization**: SIMD acceleration and memory pooling

- **User Interface**: Intuitive popup interface for extension management
  - **Model Selection**: Easy switching between different AI models
  - **Status Monitoring**: Real-time initialization and download progress
  - **Settings Management**: User preferences and configuration options
  - **Cache Management**: Visual cache statistics and cleanup controls

### Technical Foundation

- **Extension Architecture**: Robust Chrome extension with background scripts and content injection
- **Worker-based Processing**: Offscreen document for heavy computational tasks
- **Memory Management**: LRU caching and efficient resource utilization
- **Error Handling**: Comprehensive error reporting and recovery mechanisms
- **TypeScript Implementation**: Full type safety and modern JavaScript features

### Initial Features

- Multi-tab content analysis and search
- Real-time semantic similarity computation
- Automated web page interaction
- Cross-platform native messaging
- Extensible tool framework for future enhancements
