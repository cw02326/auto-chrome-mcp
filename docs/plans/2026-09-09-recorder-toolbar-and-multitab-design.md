# 녹화 도구 막대 한국어화·고도화 + 여러 탭 녹화·재생 설계

- 작성일: 2026-09-09 (같은 날 Codex 교차 검증 반영 개정, 개정 이력은 문서 끝)
- 대상 버전: 1.13.0 기준, 목표 1.14.0
- 성격: 설계 문서. 코드 수정 없음. 사용자 피드백 2건(도구 막대 한국어화, 여러 탭 녹화·재생)에 대한 결정과 구현 순서를 정한다.
- 근거: 2026-09-09 서브에이전트 조사 결과(조사 A·B)와 Codex(gpt-6-astra) 교차 검증을 근거로 삼고, 결정에 필요한 파일만 직접 읽었다. 읽은 파일 목록은 문서 끝에 있다.

---

## 0. 한 장 요약

| 항목               | 결정                                                                                                                                                                                                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 도구 막대 문구     | `chrome.i18n.getMessage` + 로케일 키(`recorder_*`). recorder.js 안에 한국어 폴백 사전(치환 포함). `default_locale` 은 `ko` 로 확정(wxt.config.ts:43).                                                                                                                                                                             |
| 도구 막대 격리     | closed Shadow DOM + `adoptedStyleSheets`(실패 시 `<style>` 폴백). 시스템 폰트 스택. 페이지 막대에는 입력값을 표시하지 않는다.                                                                                                                                                                                                     |
| 경과 시간·단계 수  | `broadcastTimelineUpdate()` payload 에 `startedAt`, `stepCount`, `status` 추가. 사이드패널 1초 폴링은 그대로.                                                                                                                                                                                                                     |
| 탭 합류 규칙(녹화) | **사용자 확정: `onActivated` 무조건 합류 유지.** 녹화 중 활성화한 탭은 전부 세션에 들어온다. 확인 안내는 만들지 않는다. 대신 "녹화 중 생성된 세션 자식 탭" 이 아닌 탭이 처음 합류하면 `openTab{url, tabRef}` 를 자동 기록해 재생이 그 주소를 새 탭으로 열게 한다. 주입 불가 탭(chrome:, 확장 페이지 등)은 단계를 기록하지 않는다. |
| 재생 시 탭 식별    | 녹화가 확정한 논리 번호 `tabRef` 를 쓴다. **재생은 번호를 추측하지 않는다.** 번호가 묶이는 경로는 `openTab{tabRef}` 와 클릭 단계의 `opensTab{tabRef}` 기대 둘뿐. 모호하면 후속 조작 전에 중단.                                                                                                                                    |
| `a[target=_blank]` | 녹화기의 기존 변환(클릭 대신 `openTab` + `switchTab`)을 유지하고 `tabRef` 를 붙인다. 재생은 주소를 직접 연다. `window.open`·JS 클릭 등 href 로 예측할 수 없는 생성만 `opensTab` 기대로 다룬다.                                                                                                                                    |
| 소유·흡수          | 흡수는 "무장된 기대에 맞아 생성이 확인된 탭" 만 run 소유로 넣는다. `openerTabId` 만으로 소유로 보지 않는다. 정리는 개별 탭 id 기준. 일반 Run 도 spawn scope 를 열되 소유 판정 콜백 연결을 필수로 한다.                                                                                                                            |
| 워커 종료          | 재시작 시 진행 중 run 은 `stopped(worker_restarted)` 로 바꾸고 재개하지 않는다. 탭을 다시 훑어 번호를 붙이는 복구는 금지.                                                                                                                                                                                                         |
| 스키마             | `StepOpenTab`·`StepSwitchTab`·`StepCloseTab` 에 `tabRef?: number`, `StepClick`·`StepDblclick` 에 `opensTab?: { tabRef: number; urlContains?: string }` 추가. 흐름 `meta.features: ['multitab']` 표시 + 구버전 실행 차단 게이트를 먼저 배포.                                                                                       |
| PR                 | PR A(도구 막대) → PR B0(구버전 차단 게이트, 작게) → PR B(여러 탭 최소 단위). 셋 다 1.14.0. recorder.js 는 A 와 B 가 함께 만지므로 A 먼저 머지 후 B 리베이스.                                                                                                                                                                      |

---

## 1부. 녹화 도구 막대 한국어화·고도화

### 1.1 문구 체계 결정

**결정: `chrome.i18n.getMessage` + 로케일 키. recorder.js 에는 한국어 폴백 사전을 둔다.**

근거

- 조사 A 에서 recorder.js 가 ISOLATED 월드로 주입되므로 `chrome.i18n` 을 쓸 수 있음이 확인됐다. 사이드패널 문구(`sidepanel_record_*`)와 같은 파일(`_locales/ko/messages.json`)에 두면 문구 관리 창구가 하나가 된다.
- 폴백 사전을 두는 이유: 키 누락·빌드 실수·테스트 환경(`chrome` 객체 없음)에서 버튼이 텅 비어 보이는 것을 막는다. 폴백 사전은 한국어다. 어떤 경로로도 한자가 화면에 나오지 않는다.
- 헬퍼 `t(key, subs = [])`:
  1. `globalThis.chrome?.i18n?.getMessage` 가 함수일 때만 호출하고, 예외는 삼킨다(`chrome` 자체가 없는 환경 대비).
  2. 결과가 빈 문자열이면 `FALLBACK_KO[key]` 를 쓰고, 폴백 문자열의 `$1`·`$2` 도 `subs` 로 치환한다(Codex 사소 2).
  3. 둘 다 없으면 키 문자열을 그대로 돌려준다(개발 중 눈에 띄게).

키 명명 규칙

- 접두어 `recorder_` 고정. `recorder_{영역}_{뜻}`. 영역은 `badge`, `opt`, `btn`, `timeline`, `step`, `session` 여섯 개.
- 치환값은 `$1`, `$2` 자리표시자.
- 로케일 파일은 ko·en 두 개에만 키를 넣는다. `default_locale` 은 `ko` 다(wxt.config.ts:43). ja·de 는 키가 108개뿐이라 이미 ko 폴백으로 동작 중이므로 이번에도 추가하지 않는다. ja·de 보강은 별도 작업.

### 1.2 21개 문자열 한국어 확정 표

비개발자 눈높이로 정했다. "탭 전환" 같은 기술 표현 대신 무슨 일이 일어나는지 말하는 문장으로 푼다.

| #   | 위치                | 원문              | 한국어 확정 문구                           | 키                                                        |
| --- | ------------------- | ----------------- | ------------------------------------------ | --------------------------------------------------------- |
| 1   | L205 배지           | 录制中            | 녹화 중                                    | `recorder_badge_recording`                                |
| 2   | L207 체크박스       | 隐藏输入值        | 입력한 글자 가리기                         | `recorder_opt_hide_values`                                |
| 3   | L210 체크박스       | 高亮              | 클릭할 곳 표시                             | `recorder_opt_highlight`                                  |
| 4   | L212 버튼           | 折叠              | 접기                                       | `recorder_btn_collapse`                                   |
| 5   | L213 버튼           | 暂停              | 일시정지                                   | `recorder_btn_pause`                                      |
| 6   | L214 버튼           | 停止              | 녹화 끝내기                                | `recorder_btn_stop`                                       |
| 7   | L235 타임라인 헤더  | 已录制步骤        | 녹화된 단계                                | `recorder_timeline_title`                                 |
| 8   | L268 토글           | 展开              | 펼치기                                     | `recorder_btn_expand`                                     |
| 9   | L304 배지 갱신      | 已暂停            | 잠시 멈춤                                  | `recorder_badge_paused`                                   |
| 10  | L305 토글           | 继续              | 이어서 녹화                                | `recorder_btn_resume`                                     |
| 11  | L424                | 未知步骤          | 알 수 없는 단계                            | `recorder_step_unknown`                                   |
| 12  | L428                | 双击 / 点击       | 두 번 클릭 / 클릭                          | `recorder_step_dblclick` / `recorder_step_click`          |
| 13  | L433                | 输入              | 입력                                       | `recorder_step_fill`                                      |
| 14  | L436                | 容器 / 页面       | 목록 안 / 페이지                           | `recorder_scroll_container` / `recorder_scroll_page`      |
| 15  | L438                | 滚动              | 스크롤                                     | `recorder_step_scroll`                                    |
| 16  | L440                | 打开标签页        | 새 탭 열기                                 | `recorder_step_open_tab`                                  |
| 17  | L441                | 切换标签页 / 包含 | 다른 탭으로 이동 / 주소에 포함             | `recorder_step_switch_tab` / `recorder_step_url_contains` |
| 18  | L443                | 切换Frame / 包含  | 페이지 안 작은 화면으로 이동 / 주소에 포함 | `recorder_step_switch_frame` / (17과 같은 키 재사용)      |
| 19  | L444                | 等待              | 기다리기                                   | `recorder_step_wait`                                      |
| 20  | L447                | 步骤              | 단계                                       | `recorder_step_generic`                                   |
| 21  | L881 세션 기본 이름 | 未命名录制        | 이름 없는 녹화                             | `recorder_session_untitled`                               |

판단 메모

- 17번은 "탭 전환" 이 아니라 "다른 탭으로 이동". 2부의 `tabRef` 가 붙으면 "$1번 탭으로 이동"(`recorder_step_switch_tab_ref`). 번호가 없는 옛 단계는 "다른 탭으로 이동: 주소에 example.com 포함".
- 18번 프레임은 "페이지 안 작은 화면" 으로 풀었다. 괄호 설명은 넣지 않는다.
- 9번 배지는 "잠시 멈춤", 5번 버튼은 동작이므로 "일시정지".
- 6번은 "녹화 끝내기". "정지" 는 일시정지와 헷갈린다.
- 13번 입력 단계는 페이지 막대에서 **값을 표시하지 않는다**(1.3 참고). 표시 형식은 "입력: #id" 까지.

### 1.3 UI 설계

원칙

- 글자 있는 버튼 유지. 최소 글자 12px, 버튼 본문 13px, 배지 13px 600.
- 녹화 중 배지는 빨간 점(지름 8px, 1초 주기 깜빡임. `prefers-reduced-motion: reduce` 면 깜빡임 없음) + "녹화 중" + 경과 시간 + 단계 수. 잠시 멈춤이면 점이 회색 고정.
- 페이지 내용을 가리지 않는 규칙: (1) 기본 위치 오른쪽 위 10px. (2) 막대 머리 부분을 끌어 네 귀퉁이 중 하나로 옮긴다(4 귀퉁이 스냅). 키보드: 막대에 포커스가 있을 때 `Alt+화살표` 로 귀퉁이 이동. 위치는 배경에 `rr_toolbar_corner` 로 저장해 다른 탭에도 같은 귀퉁이에 뜬다. (3) "접기" 는 막대 전체를 알약 하나로 줄인다. 접힌 상태에서도 "녹화 끝내기" 는 알약 안에 남아 한 번에 누를 수 있다(접근성: 접힌 상태에서 정지까지 2단계 이상 걸리면 안 된다). (4) 타임라인 최대 높이 220px, 폭 360px, 뷰포트 480px 미만이면 `calc(100vw - 20px)`.
- **페이지 막대의 타임라인은 요약만 보여준다.** 입력값·변수값·URL 쿼리 문자열은 표시하지 않는다(Codex 8: 페이지가 막대 내용을 읽을 수 있고, 멀티탭이 되면 다른 탭에서 입력한 값까지 노출 범위가 커진다). 전체 타임라인과 값은 사이드패널에서 본다. 페이지 막대의 항목 형식은 "N. 종류: 셀렉터 또는 탭 번호" 까지.
- 하이라이트 박스 `pointer-events: none` 유지.

접힌 상태(텍스트 목업)

```
                                   +--------------------------------------+
                                   | ● 녹화 중 01:24 · 7단계  펼치기  끝내기 |
                                   +--------------------------------------+
```

펼친 상태(텍스트 목업)

```
                         +-----------------------------------------------------+
                         | ● 녹화 중  01:24 · 7단계                            |
                         | [ ] 입력한 글자 가리기   [x] 클릭할 곳 표시           |
                         |            [ 접기 ]   [ 일시정지 ]   [ 녹화 끝내기 ]  |
                         +-----------------------------------------------------+
                         | 녹화된 단계                                          |
                         |  1. 클릭: #login                                     |
                         |  2. 입력: #id                                        |
                         |  3. 새 탭 열기 (2번 탭)                              |
                         |  4. 2번 탭으로 이동                                  |
                         |  5. 클릭: a.more                                     |
                         +-----------------------------------------------------+
```

- 잠시 멈춤 상태: 첫 줄이 `○ 잠시 멈춤  01:24 · 7단계`, 가운데 버튼이 `이어서 녹화`.
- 2부의 "녹화할 수 없는 페이지" 안내는 사이드패널 상태줄에 둔다(2.3). 도구 막대는 세션 탭에만 뜨므로 막대로는 알릴 수 없다.

### 1.4 격리 방식 결정

**결정: closed Shadow DOM + `adoptedStyleSheets`, 실패 시 `<style>` 폴백. 폰트는 시스템 스택.**

근거와 세부(Codex 7 반영)

- host 요소(`#__rr_rec_overlay`)는 light DOM 에 남으므로 페이지 CSS·ID 충돌·삭제 영향을 받는다. host 에는 `all: initial; position: fixed; z-index: 2147483646; inset 값` 만 인라인으로 두고, shadow 안 첫 요소에서 `all: initial` 로 상속 속성(color, font, direction, line-height)을 다시 초기화한다. host id 는 유지하되(중복 주입 검사·클릭 제외 판정이 이 id 를 본다) 페이지가 host 를 지우면 `MutationObserver` 로 감지해 다시 붙인다(최대 3회, 그 뒤 포기하고 사이드패널 표시만).
- closed 모드를 고르는 이유: 페이지 스크립트가 `host.shadowRoot` 로 내용을 읽지 못한다. 그래도 host 삭제·가림은 막지 못하므로 민감값을 아예 넣지 않는 1.3 규칙이 본선이다.
- z-index 는 top layer(`<dialog>`·popover)와 전체화면을 이기지 못하고, 조상 `transform` 도 fixed 를 깨뜨릴 수 있다. host 를 `document.documentElement` 직속으로 붙이는 지금 방식은 유지하고(조상 transform 회피), top layer 위에 뜨는 것은 지원하지 않는다고 명시한다. 사용자는 사이드패널에서 항상 정지할 수 있다.
- 스타일 시트: `new CSSStyleSheet()` 생성, `replaceSync(css)`, `shadow.adoptedStyleSheets = [sheet]` 세 단계를 각각 try 로 감싸고 어느 하나라도 실패하면 shadow 안에 `<style>` 요소를 넣는다.
- CSP·Trusted Types: ISOLATED 월드는 페이지 CSP 의 script 제약을 받지 않지만, Trusted Types 강제 페이지에서 `innerHTML` 같은 DOM sink 가 콘텐츠 스크립트에도 막히는지는 실기기 확인 항목으로 둔다(1.6). 안전을 위해 신규 코드는 `innerHTML` 대신 `createElement` 조합으로 짠다(기존 L203-215 의 innerHTML 도 이 기회에 바꾼다).
- `remove()` 는 shadow 내부가 아니라 **host 를 제거**한다. `MutationObserver` 도 이때 해제해 재부착이 일어나지 않게 한다.
- 폰트: `'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Malgun Gothic', sans-serif`. 웹폰트 로드는 하지 않는다(로드 지연·차단·`web_accessible_resources` 등록 비용).
- 코드 영향: `updateStatus()`, `appendStep()`, `resetTimeline()` 의 `document.getElementById` 를 `this._shadow.querySelector` 로 바꾼다. `_onClick` 의 막대 클릭 제외 판정(L1221-1222)은 host 기준이라 그대로 동작하지만, shadow 안 요소가 `event.target` 으로 오면 `composedPath()` 첫 요소가 shadow 내부이므로 `el.closest('#__rr_rec_overlay')` 대신 `event.composedPath().includes(host)` 로 판정한다.

토스 토큰 중 실제로 쓸 값(`ui/theme.css` 값을 복제)

| 용도                 | 값                                                                |
| -------------------- | ----------------------------------------------------------------- |
| 막대 배경            | `#ffffff`, 그림자 `0 4px 16px rgba(0,0,0,0.16)`                   |
| 본문 글자            | `#191f28` (theme.css 의 기본 텍스트 토큰 값이 다르면 그 값)       |
| 녹화 점·끝내기 버튼  | `#ef3341`, hover `#de2b39`, 연한 배경 `#ffefef`                   |
| 일시정지·펼치기 버튼 | 배경 `#f6f7f9`, 글자 `#191f28`, hover `#e9ebee`                   |
| 이어서 녹화 버튼     | `#3182f6`, hover `#2272eb`, 글자 흰색                             |
| 모서리               | 막대 8px, 접힌 알약 999px                                         |
| 타임라인             | 배경 `#ffffff`, 항목 구분 `#f2f4f6` 1px 하단선(왼쪽 세로 띠 금지) |

### 1.5 상태 동기화 설계

- `session-manager.ts` `broadcastTimelineUpdate()` 메시지를 `{ action: RR_TIMELINE_UPDATE, steps, startedAt, stepCount, status }` 로 넓힌다. `steps` 는 페이지 막대용으로 **값을 뺀 요약**(`type`, `selector`, `tabRef`, `url` 의 origin+path 까지)만 싣는다. `startedAt` 은 `RecordingSessionState` 에 없으면 추가하고 `start()` 에서 채운다(`start()` 본문은 읽지 않았으므로 구현 시 확인). `status` 는 `'recording' | 'paused'`.
- `fullSteps.length === 0` 조기 반환을 없앤다. 막대가 "00:00 · 0단계" 를 그릴 수 있어야 한다.
- recorder.js 는 받은 `startedAt` 으로 로컬 `setInterval(1000)` 을 돌린다. 일시정지 중 시계는 멈추지 않는다.
- **사이드패널 1초 폴링은 그대로 둔다.** 정지 버튼은 같은 `rr_stop_recording` 을 타므로 배경 상태는 즉시 바뀌고 표시만 최대 1초 늦는다. push 전환은 1.14 이후 항목.

### 1.6 검증 방법

1. 한자 0 검사(파이썬, **제품 문구만**): `recorder.js`, `_locales/ko/messages.json`, `_locales/en/messages.json` 에 U+4E00 ~ U+9FFF 가 0개. 실기기 화면 검사는 사용자 사이트 제목·입력값(한자가 정상적으로 들어갈 수 있음)을 제외하고 막대의 고정 문구·버튼·헤더만 본다.
   ```
   python -c "import re,sys,pathlib;p=pathlib.Path(sys.argv[1]).read_text(encoding='utf-8');print(len(re.findall(r'[一-鿿]',p)))" app/chrome-extension/inject-scripts/recorder.js
   ```
2. 대시류 0 검사(파이썬): 같은 파일들에 U+2014, U+2013, U+3161, U+2015, U+2012, U+FF0D, U+2212 가 0개.
3. 빌드·타입: `./node_modules/.bin/wxt build` 성공, `vue-tsc --noEmit` 신규 오류 0(기존 41건 기준).
4. 실기기(example.com): 녹화 시작 → 흰 바탕·빨간 점·"녹화 중 00:0x · 0단계" → 클릭 2번 → "2단계" → 접기 → 알약에 "끝내기" 가 남아 있다 → 마우스로 귀퉁이 끌기 + `Alt+화살표` 로 귀퉁이 이동 → 링크 새 탭 열기 → 새 탭에도 같은 귀퉁이·이어진 시각 → 녹화 끝내기 → 모든 탭에서 막대 소멸, 사이드패널 1초 안에 끝남.
5. 격리: `button{all:unset}`, `html{transform:scale(.9)}`, `<dialog open>` 을 가진 로컬 테스트 페이지에서 버튼 모양 유지 여부, dialog 위에 뜨지 않음을 확인하고 문서에 결과를 적는다. Trusted Types 강제(`Content-Security-Policy: require-trusted-types-for 'script'`) 로컬 페이지에서 막대가 뜨는지 확인한다(안 뜨면 `<style>` 폴백·createElement 경로 점검).
6. `prefers-reduced-motion: reduce` 에뮬레이션에서 점이 깜빡이지 않는다. 페이지 막대 타임라인에 입력값이 나타나지 않는다(입력 후 항목이 "입력: #id" 까지만).

---

## 2부. 여러 탭에 걸친 녹화·재생 설계

### 2.0 문제 정리와 확인된 사실

조사 B 와 Codex 검증으로 확인된 현재 동작

- 녹화는 다른 탭을 따라간다. `onActivated` 가 무조건 세션에 넣고 `SWITCH_TAB { urlContains }` 를 남긴다.
- **`recorder.js` `_onClick` L1226-1236: `a[href][target=_blank]` 를 클릭하면 클릭 단계를 남기지 않고 `openTab{url}` + `switchTab{urlContains}` 를 넣고 `return` 한다.** 페이지가 여는 탭 중 이 경우만 이미 "명시적 열기" 로 변환돼 있다. `window.open`·JS 가 여는 탭은 그냥 클릭으로 남고, 그 뒤 `onActivated` 가 `switchTab{urlContains}` 를 붙인다.
- 재생은 `switchTabNode`(nodes/tabs.ts L69-90)와 `switchTabHandler`(actions/handlers/tabs.ts L118-175)가 모두 `tabId` 필수 + run 소유 탭만 허용이라 100% `tab_scope_violation`.
- **`closeTabNode` L133-137: `tabIds`·`url` 이 없으면 `tabIds = [await resolveRunTab(ctx)]` 로 현재 run 탭을 닫는다.** 따라서 새 필드 `tabRef` 만 있는 `closeTab` 을 구버전이 만나면 인자 없음으로 보고 현재 탭을 닫는다. "구버전은 새 필드를 무시할 뿐" 이라는 초판의 전제는 틀렸다.
- `scheduler.ts` `closeOwnedTabs()` 는 abort 에서만 부른다. 정상 종료는 탭을 남긴다(결과 확인용). 이 정책은 바꾸지 않는다.
- `RunState`(engine/state-manager.ts) 에는 `id, flowId, name, status, startedAt, updatedAt` 만 있다. 탭 소유·매핑은 전부 메모리다.
- `spawned-tab-tracker.ts` 는 `tabs.onCreated` 와 `webNavigation.onCreatedNavigationTarget`(L433) 두 이벤트를 `upsert` 로 합쳐 생성 기록 하나를 만들고, `scopeForOpener`(L228-232)는 `getSessionScopedTabIds(scope.sessionKey)` 만 본다.
- `runTabFromId`(tab-context.ts L359-383)와 `actions/adapter.ts` L105-135 는 컨텍스트 필드를 **명시적으로 복사**한다. 새 필드는 여기 두 곳에 추가하지 않으면 두 실행기에 전달되지 않는다.

지켜야 할 불변식(Codex C4 반영해 I3 를 둘로 나눔)

- I1. run 은 자기에게 주어진 탭과 자기가 만든 것으로 **확인된** 탭 밖으로 나가지 않는다.
- I2. url·title 로 브라우저 전체를 뒤져 탭을 **고르지** 않는다. 이미 정해진 탭의 URL 을 **검증** 하는 것은 이와 다르며 허용된다.
- I3a. 재생 코드는 탭 활성화·창 포커스 요청을 하지 않는다.
- I3b. 사이트가 스스로 연 탭·팝업이 화면을 가져가면 사후에 되돌린다(순간적 포커스 이동은 막을 수 없음을 인정한다).

### 2.1 재생 시 탭 식별: 결정

**결정: `tabRef` 는 녹화가 확정한 논리 번호이고, 재생은 번호를 추측하지 않는다. 번호가 실제 탭에 묶이는 경로는 정확히 둘이다. (1) `openTab{tabRef}` 가 만든 탭, (2) 클릭 단계의 `opensTab{tabRef}` 기대에 맞아 생성이 확인된 탭. 그 밖의 방법으로 생긴 탭은 어떤 번호에도 묶이지 않고 run 소유가 되지 않는다.**

왜 초판(재생 쪽 흡수 카운터)을 버리는가(Codex C1)

- 생성 순서는 결정적이지 않다(광고 탭·리다이렉트 중 추가 탭·지연 팝업·녹화 때만 열렸던 인증 탭). 번호가 밀리면 "다음 셀렉터가 실패한다" 는 안전망도 두 탭이 같은 서비스 UI 일 때(`button[type=submit]` 이 양쪽에 있음) 작동하지 않고 오입력·오제출이 조용히 성공한다. 소유권 검사는 이 오류를 막지 못한다.

run 별 공유 상태 객체(Codex 6)

- 새 타입 `RunTabState` 를 `engine/tab-context.ts` 에 둔다. 객체 하나를 run 이 만들고, `RunTabContext.tabState`, `runTabFromId()` 의 복사 목록, `actions/adapter.ts` 의 컨텍스트 생성 목록에 **참조로** 넘긴다. 숫자나 배열을 값으로 복사하지 않는다.
  ```
  interface RunTabState {
    ownedTabIds: Set<number>;            // 기존 필드를 이 객체로 옮긴다(참조 공유는 지금도 그렇게 한다)
    tabRefs: Map<number, number>;        // tabRef -> tabId. 한 번 묶이면 바뀌지 않는다
    closedRefs: Set<number>;             // 닫힌 tabRef. 재사용·재바인딩 금지
    expectation: NewTabExpectation | null; // 동시에 하나만 무장한다
    scopeKey: string;                    // spawn scope 의 sessionKey ('run::' + runId)
  }
  ```
- 기존 `ownedTabIds`·`entryTabId`·`leasedTabIds` 는 당장 옮기지 않고 `tabState` 를 **추가** 한다(옮기면 테스트·어댑터 변경 폭이 커진다). `runOwnedTabIds(ctx)` 는 그대로 쓴다.

핵심 함수(모두 `engine/tab-context.ts`, 두 실행기가 공통으로 부른다)

- `bindTabRef(state, ref, tabId)`: `ref` 가 정수 0 이상이 아니면 throw. `tabRefs.has(ref)` 또는 `closedRefs.has(ref)` 면 `RunTabError('tab_ref_conflict')`. `ownedTabIds.has(tabId)` 가 아니면 throw(소유 등록이 먼저다). 그 뒤 `tabRefs.set`.
- `resolveTabRef(state, ref)`: `tabRefs.get(ref)` 가 없으면 `tab_ref_unbound`, 있으면 `isRunOwnedTab` 재확인 후 반환. **`ref === 0` 은 유효하다. truthy 검사 금지.**
- `resolveSwitchTarget(ctx, { tabRef, tabId })`: `tabRef` 가 있으면 그것만 쓴다(`tabId` 가 함께 있으면 무시하고 경고 로그). `tabRef` 가 없고 `tabId` 가 있으면 지금 코드와 같이 `isRunOwnedTab` 검사. 둘 다 없으면 지금과 같은 `tab_scope_violation`. **대기는 하지 않는다**(묶임은 클릭 단계가 끝날 때 이미 확정돼 있어야 한다. 2.4).
- `markRunOwnedTab` 은 그대로. `tabRefs.set(0, ensured.tabId)` 는 `scheduler.prepareExecution()` 이 `prepareRunTab` 직후 한다(`ownedTabIds` 검사는 0번에 한해 건너뛴다. 초기 탭은 소유가 아니라 "주어진 탭" 이므로).

불변식과의 관계

- I1 유지: 묶이는 경로 둘 다 `markRunOwnedTab` 이 선행되고, `bindTabRef` 가 이를 검사한다. `resolveTabRef` 도 소유를 재확인한다.
- I2 유지: 탭을 고르는 데 URL 을 쓰는 코드는 없다. `opensTab.urlContains` 와 `switchTab.urlContains` 는 **이미 묶인 탭** 의 URL 검증에만 쓴다(2.4).
- I3a 유지: 활성화 코드 추가 없음. I3b: spawn scope 의 `restoreUserView` 가 담당(2.5).
- 바뀌는 것: (a) `switchTab` 이 `tabId` 없이 `tabRef` 로 실행된다. (b) run 소유 집합이 실행 중에 자랄 수 있으나, 자라는 조건은 "무장된 기대에 맞은 생성 확인" 하나뿐이다.

### 2.2 새 탭 생성 기록: 원인 단계에 기대를 붙인다

`expectNewTab` 을 별도 단계로 두지 않고 **클릭 단계의 필드** 로 둔다.

**결정: `StepClick`·`StepDblclick` 에 `opensTab?: { tabRef: number; urlContains?: string }` 추가.**

이유

- 기대는 클릭이 실행되기 **전에** 무장돼야 하고, 결과 판정은 클릭 직후에 같은 실행 단위 안에서 끝나야 한다. 별도 단계로 두면 Builder 에서 순서가 바뀌거나 한쪽만 지워져 "기대 없는 클릭" 또는 "클릭 없는 기대" 가 생길 수 있다. 필드면 그 일이 구조적으로 불가능하다.
- 재생 실행기 변경 범위가 클릭 노드 하나(+actions 클릭 핸들러)로 한정된다.
- 포기하는 것: 클릭 외의 원인(키보드 Enter 로 폼 제출이 새 탭을 여는 경우, 페이지 타이머)은 첫 버전에서 지원하지 않는다. 이런 탭은 녹화 시 `openTab{url, tabRef}` 로 대체 기록되고(아래 표), 재생은 그 주소를 직접 연다.

녹화 규칙(세 경우 + 추가 경우)

| 사용자 행동                                                          | 녹화 단계                                                                                                                                                        | 재생 동작                                                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `a[href][target=_blank]` 클릭, href 가 http(s)                       | **기존 변환 유지**: `openTab{url, tabRef: n}` + `switchTab{tabRef: n}`. 클릭은 남기지 않는다.                                                                    | `openTabNode` 가 백그라운드 탭을 만들어 n 에 묶는다. 결정적이라 모호성이 없다.      |
| `a[href][target=_blank]` 인데 href 가 `javascript:`·`#`·빈 값        | 클릭 단계로 떨어뜨린다(아래 행).                                                                                                                                 | 아래 행.                                                                            |
| `window.open`·JS 클릭·폼 `target=_blank` 등 href 로 예측 불가한 생성 | 클릭 단계 `click{target, opensTab: { tabRef: n, urlContains: 첫 커밋 URL의 origin+path }}` + `switchTab{tabRef: n}`. `opensTab` 은 배경이 사후에 붙인다(2.3 큐). | 클릭 노드가 기대를 무장하고 클릭 후 **정확히 하나** 의 생성 확인을 기다린다(2.4).   |
| 우클릭·가운데 클릭 "새 탭에서 열기"                                  | 녹화기가 이 클릭을 잡지 않으므로 원인 단계가 없다 → 배경이 `openTab{url, tabRef: n}` 으로 대체 기록 + `switchTab`. 타임라인에는 "새 탭 열기 (n번 탭)" 로 보인다. | `openTabNode`.                                                                      |
| 주소창으로 새 탭을 열어 주소 입력                                    | 자동 합류(2.3). 세션 자식 탭이 아니므로 합류 시점에 `openTab{url, tabRef: n, origin: 'joined'}` + `switchTab{tabRef: n}` 자동 기록.                              | `openTabNode`. 사용자가 주소를 입력하는 과정은 재현하지 않고 최종 주소를 바로 연다. |
| 녹화 전부터 있던 탭으로 전환                                         | 위와 같음(자동 합류 + `openTab{origin:'joined'}` 자동 기록).                                                                                                     | 위와 같음.                                                                          |
| chrome:·about:·확장 페이지·file: 등 주입 불가 탭으로 전환            | 세션에 넣지 않고 단계를 기록하지 않는다(2.3).                                                                                                                    | 해당 없음.                                                                          |
| 세션 탭 간 전환                                                      | `switchTab{tabRef: m}`                                                                                                                                           | `resolveTabRef`.                                                                    |
| 세션 탭 닫기                                                         | `closeTab{tabRef: n}`                                                                                                                                            | `closeTabNode` 가 n 을 해석해 그 탭만 닫고 `closedRefs` 에 넣는다.                  |

`recorder.js` `_blank` 분기의 변경(코드 수준)

- L1226-1236 의 두 `_pushStep` 은 유지하되 `tabRef` 를 넣지 않는다. 콘텐츠 스크립트는 세션 번호를 모른다. 대신 `openTab` 단계에 `_opener: 'blank_link'` 임시 표식을 붙여 보내고, 배경 `appendSteps` 가 큐에서 이 단계를 받을 때 `nextTabRef` 를 배정해 `openTab.tabRef` 와 바로 다음 `switchTab.tabRef` 에 같은 번호를 넣고 표식을 지운다. 배정한 번호는 `pendingBlankRef = { ref, url, at }` 로 잠시 보관했다가, 이어서 생성 기록(opener ∈ 세션, url 이 그 주소로 시작)이 오면 그 탭 id 에 `tabRefs.set(tabId, ref)` 로 묶는다(녹화 쪽 매핑). 1500ms 안에 생성 기록이 오지 않으면(팝업 차단·`rel=noopener` 로 opener 가 끊긴 경우 등) 번호는 그대로 두고 경고 로그만 남긴다.
- `href` 가 `javascript:`·`#`·빈 값이면 이 분기를 타지 않게 조건에 `/^https?:/i.test(abs)` 를 추가한다. 그러면 일반 클릭 경로로 내려가 클릭이 남고, 배경이 생성 기록을 보고 `opensTab` 을 붙인다.
- 이 파일은 PR A(도구 막대)도 만진다. 3.1 에서 겹침을 다룬다.

`opensTab` 사후 부착 규칙(배경, 2.3 큐 안에서)

- 생성 기록(tracker 의 단일 기록)이 오고 opener 가 세션 탭이며 `pendingBlankRef` 에 맞지 않을 때, 같은 opener 탭에서 **직전 1500ms 안에** 기록된 마지막 단계가 `click`·`dblclick` 이고 아직 `opensTab` 이 없으면 그 단계에 `opensTab{tabRef: n, urlContains}` 를 붙인다. 조건에 맞는 단계가 없으면 `openTab{url, tabRef: n}` 대체 기록. 한 클릭에 생성 기록이 둘 이상 오면 첫 번째만 클릭에 붙이고 나머지는 각각 `openTab` 대체 기록으로 남기며 타임라인에 "자동으로 열린 탭" 표식을 단다(재생 시 주소를 직접 열게 되므로 사용자가 지울 수 있다).

스키마 변경

- `legacy-types.ts`: `StepOpenTab`·`StepSwitchTab`·`StepCloseTab` 에 `tabRef?: number`, `StepOpenTab` 에 `origin?: 'joined' | 'blank_link' | 'auto'`(어떻게 생긴 단계인지 표시용), `StepClick`·`StepDblclick` 에 `opensTab?: { tabRef: number; urlContains?: string }`. 선택 필드 추가.
- 흐름 `meta.features?: string[]` 에 `'multitab'` 을 넣는다(탭 단계에 `tabRef` 가 하나라도 있으면). 구버전 차단 게이트(2.8)가 이 표시를 본다.
- `node-specs-builtin.ts`: switchTab 스펙(조사 B 기준 L447-457)에 `tabRef` 필드 라벨 "몇 번째 탭". openTab·closeTab·click 스펙도 같은 필드. Builder 컴포넌트(node-spec-registry 소비처)는 조사에서 찾지 못했으므로 구현 시 grep 으로 노출 여부 확인.
- node↔step 매핑(`mapDagNodeToStep`, 조사 B 는 `rr-graph.ts:240-251` 로 지목했으나 그 경로에 파일이 없어 구현 시 위치를 grep 으로 잡는다): 필드 통째 복사면 변경 없음, 화이트리스트면 두 필드 추가.
- `sidepanel/utils/card-format.ts`: "N번 탭으로 이동" / "새 탭 열기 (N번 탭)" / "N번 탭 닫기" / 클릭 카드에 "새 탭이 열림 (N번 탭)" 부가 표시.
- 유효성: `tabRef` 는 0 이상의 정수. 음수·소수·NaN·중복은 저장 시 검증 오류(사이드패널 "탭 번호가 잘못됐어요"). `switchTab{tabRef: n}`·`closeTab{tabRef: n}` 앞에 n 을 만드는 단계(`openTab{tabRef: n}` 또는 `opensTab{tabRef: n}`)가 없으면 저장 시 "n번 탭을 여는 단계가 없어요" 로 거절한다(0번은 예외).

### 2.3 녹화: 합류 규칙과 단일 기록 큐

**합류 규칙(사용자 확정, 2026-09-09): `onActivated` 무조건 합류를 유지한다.** 녹화 중 사용자가 활성화한 탭은 opener 관계·생성 시점과 무관하게 세션에 들어오고 리코더가 주입된다. 사이드패널 확인 안내(`rr_tab_outside_session`, [이 탭도 녹화하기])는 만들지 않는다. 사용자는 "메일 탭 같은 무관한 탭도 녹화에 들어온다" 는 설명을 듣고 편의를 택했다. Codex 의 "세션 자식 탭으로 좁혀라" 권고는 이 항목에 한해 채택하지 않는다(3.4).

이 결정이 만드는 문제와 해결

- 세션에 들어왔지만 재생이 만들어 낼 수 없는 탭이 생긴다. 녹화 전부터 있던 탭으로 전환하면 `switchTab{tabRef: n}` 만 남고 n 을 만든 단계가 흐름에 없어 재생이 `tab_ref_unbound` 로 멈춘다. (가)에서는 이것이 예외가 아니라 흔한 경로다.
- **해결: 처음 합류하는 탭이 "녹화 중 생성된 세션 자식 탭" 이 아니면, 합류 시점에 `openTab{ url: 그 탭의 현재 주소, tabRef: n, origin: 'joined' }` 를 `switchTab{tabRef: n}` 앞에 자동 기록한다.** 재생은 "새 탭을 열어 그 주소로 간다" 로 재현한다. 초판에서 버튼이 하던 일을 버튼 없이 자동으로 한다. 근거: 재생은 사용자 탭을 만질 수 없으므로(I1) 같은 주소의 새 탭을 여는 것이 유일한 재현 수단이고, 자동으로 해야 (가)의 "그냥 되는" 편의가 유지된다.
- "세션 자식 탭" 판정 `session.isSessionChild(tabId)`: tracker 의 생성 기록(`getSpawnedTabsSince(session.startedAt)`)에서 `tabId` 를 찾고 그 기록의 opener 가 `session.hasTab(opener)` 일 때 true. tracker 는 `tabs.onCreated` 와 `onCreatedNavigationTarget` 을 `upsert` 로 합치므로 opener 가 늦게 밝혀져도 같은 기록을 본다(Codex 3). 녹화기는 별도 `onCreated` 리스너를 달지 않는다. TTL(120초)·30건 제한이 있으므로 판정 결과를 `state.childTabs: Set<number>` 에 복사한다. 자식 탭이면 `openTab{origin:'joined'}` 를 만들지 않는다(그 탭은 `_blank` 변환 또는 `opensTab` 기대가 이미 만든다. 2.2).
- `browser-event-listener.ts` `onActivated` 흐름: 큐에 `{kind:'activated', tabId}` 를 동기로 넣는다. 소비자는 (1) 주입 가능 URL 인지 확인(아래) → (2) `session.hasTab` 이 아니면 `addActiveTab`(번호 배정) → (3) 자식 탭이 아니면 `openTab{origin:'joined'}` 삽입 → (4) `switchTab{tabRef}` 삽입 → (5) 주입·START 전송. `shouldJoinSession` 은 `onCommitted` 경로에서만 쓰며 `session.hasTab(tabId) || session.isSessionChild(tabId)` 로 바뀐다(생성 시점을 보지 않던 구멍은 여기서 막는다. 활성화되지 않은 자식 탭의 자동 새로고침이 흐름에 들어오는 것을 막는 용도).

사용자에게 보이는 표시

- 페이지 막대 타임라인: `3. 새 탭 열기: example.com`(origin+host 까지만).
- 사이드패널 흐름 카드: 제목 "새 탭 열기: example.com/path", 부제 "재생할 때는 이 주소를 새 탭으로 엽니다". `origin: 'joined'` 인 카드에만 이 부제가 붙는다. `_blank` 변환(`origin:'blank_link'`)과 대체 기록(`origin:'auto'`)은 부제 없이 "새 탭 열기" 만.
- 사용자가 이 카드를 지우면 이어지는 `switchTab{tabRef: n}` 은 저장 시 검증에서 "n번 탭을 여는 단계가 없어요. 앞에 새 탭 열기 단계가 필요해요" 로 거절된다(2.2 유효성).

한계(숨기지 않는다)

- **로그인 상태에 의존하는 탭**: 녹화 때 이미 로그인돼 있던 탭을 재생이 새 탭으로 열면 같은 브라우저 프로필이므로 보통 로그인이 유지된다. 그러나 세션 쿠키가 만료됐거나, 사이트가 탭마다 토큰을 새로 요구하거나, 주소에 일회용 토큰이 들어 있으면 로그인 화면이 뜬다. 이때 다음 단계의 셀렉터가 실패하거나 `switchTab.urlContains` 검증이 `tab_url_mismatch` 로 멈춘다. 자동 로그인은 지원하지 않는다. 사이드패널 문구: "N번 탭에 예상과 다른 페이지가 열렸어요(로그인이 풀렸을 수 있어요). 안전을 위해 여기서 멈췄어요."
- **주소가 상태를 담지 못하는 탭**(SPA 내부 화면, POST 결과 페이지): 새 탭으로 열면 첫 화면이 뜬다. 같은 방식으로 멈춘다. 이런 흐름은 사용자가 그 화면까지 가는 조작을 녹화에 포함해야 한다. 카드 부제가 그 힌트다.
- **주입 불가·재현 불가 탭**(`chrome://`, `chrome-extension://`, `about:`, `file:`, 웹스토어, `devtools://`): 세션에 넣지 않고 단계를 기록하지 않는다. 이유: 재생이 이런 주소를 새 탭으로 열어도 조작할 수 없고, 리코더 주입도 실패한다. 기록하고 재생에서 멈추게 하는 대안은 사용자에게 "왜 멈추지" 만 남기므로 버린다. 대신 사이드패널 상태줄에 "이 탭은 녹화할 수 없는 페이지예요(브라우저 설정·확장 화면)" 를 1회 표시한다. `file:` 은 확장의 파일 URL 권한이 꺼져 있으면 주입 자체가 안 되므로 같은 부류로 본다. 판정 함수는 `isRecordableUrl(url)`(rr-utils 의 `isWebUrl` 이 있으므로 그것을 쓰거나 확장한다).
- **프라이버시 완화 장치**: 도구 막대의 "입력한 글자 가리기" 체크박스는 recorder.js L460 에서 `hideInputValues = false` 로 시작하므로 **기본은 꺼짐** 이다. 켜면 L683·L1420 의 `isSensitive` 판정이 모든 입력을 민감 필드로 취급해 값 대신 변수로 저장한다. (가)에서 무관한 탭의 입력이 녹화될 수 있으므로, 이 체크박스 상태를 배경에 저장해 새로 합류하는 탭에도 같은 값으로 적용한다(지금은 탭마다 인스턴스 필드라 새 탭에서 다시 꺼진다. 저장 위치는 도구 막대 귀퉁이와 같은 `rr_toolbar_prefs`). 기본값을 켜짐으로 바꾸는 것은 이번 범위에서 결정하지 않는다(사용자 확인 사항, 3.3).

**단일 기록 큐(Codex 5)**

- 지금 `onActivated` 는 주입·메시지·`tabs.get` 을 await 한 뒤 단계를 기록하므로 그 사이 다른 이벤트가 끼어든다. 주소창 새 탭은 `switchTab` 이 `openTab` 보다 앞설 수 있다.
- `session-manager.ts` 에 `RecordQueue` 를 둔다. 모든 리스너(`onActivated`, `onCommitted`, tracker 생성 기록 콜백, `onRemoved`, 콘텐츠 스크립트 `appendSteps` 수신)는 **수신 즉시 동기적으로** `{ seq: nextSeq++, sessionId, sourceTabId, kind, payload, at }` 를 큐에 넣고 반환한다. 큐는 단일 소비자가 `seq` 순서로 처리하며 그 안에서만 await(주입·`tabs.get`)를 한다. 단계 삽입·`tabRef` 배정·`opensTab` 사후 부착·`pendingBlankRef` 매칭은 전부 이 소비자 안에서 일어난다. 처리 중 `sessionId` 가 바뀌었으면 항목을 버린다.
- 콘텐츠 스크립트에서 오는 단계에도 `sourceTabId`(sender.tab.id)를 붙인다. 이미 `appendSteps(steps, { tabId })` 가 그렇게 받는다.
- 일시정지: 큐는 계속 받되 `paused` 상태에서는 단계를 만들지 않고 상태만 갱신한다. 일시정지 중 생긴 자식 탭은 `childTabs` 에 넣지 않는다(재개 후 그 탭으로 가면 자식 탭이 아닌 것으로 보아 `openTab{origin:'joined'}` 자동 기록을 거친다. 일시정지 중의 클릭은 기록되지 않았으므로 `opensTab` 기대를 붙일 원인 단계가 없기 때문이다). 일시정지 중 닫힌 세션 탭은 `tabRefs` 에서 `closed` 로 표시하고 `closeTab` 단계는 만들지 않는다(재생 시 그 탭이 남지만 조작 대상이 아니므로 무해).
- 워커 종료: 녹화 세션 상태가 메모리라면 워커 재시작 시 세션은 끝난 것으로 보고 지금까지의 단계를 초안으로 저장한 뒤 사이드패널에 "브라우저 확장이 다시 시작되어 녹화가 끝났어요. 지금까지 녹화한 내용은 저장했어요" 를 띄운다(녹화 상태의 영속 여부는 이번에 읽지 않았으므로 구현 시 확인. 영속돼 있어도 `tabRefs` 복구를 위해 탭을 훑지는 않는다).

### 2.4 재생: 기대 무장, 생성 확인, 문서 준비 검증, 중단 규칙

클릭 노드(`nodes/click` 계열과 actions 클릭 핸들러, 공통 헬퍼는 `engine/tab-context.ts`)

1. `step.opensTab` 이 있으면 클릭 **전에** `armNewTabExpectation(state, { tabRef, urlContains, openerTabId: ctx.tabId, deadline })`. 이미 무장된 기대가 있으면 `expectation_busy` 로 중단(한 번에 하나).
2. 클릭 실행.
3. `settleNewTabExpectation(state, signal)`: tracker 의 생성 기록 스트림(새 export `subscribeSpawnedTabs(listener)`)을 구독해 `openerTabId === expectation.openerTabId` 이고 `createdAt ≥ armedAt` 인 기록을 센다. 마감은 `min(step.timeoutMs ?? 10000, run deadlineAt)` 이고 `ctx.signal` abort 에 즉시 반응.
   - 기록 0건 → `new_tab_not_opened` 중단.
   - 기록 2건 이상(마감까지 관측) → `new_tab_ambiguous` 중단. 어느 것도 소유·묶기 하지 않는다. 첫 버전은 **한 동작에 새 탭 하나** 만 지원한다.
   - 정확히 1건 → `markRunOwnedTab` + `bindTabRef`. 관측 창은 첫 기록 후 500ms 를 더 기다려 두 번째 기록이 없음을 확인한 뒤 확정한다(지연 팝업 대비).
4. 기대 해제(`state.expectation = null`).

`switchTab{tabRef}` 노드

1. `resolveSwitchTarget` 으로 tabId 확정(대기 없음).
2. **문서 준비 검증**(Codex 2, 생성 확인과 분리): `waitForTabSettled(tabId, timeout, signal)`(rr-utils 에 이미 있음)로 로딩 완료를 기다린 뒤 `chrome.tabs.get(tabId).url` 을 읽는다. `about:blank`·`chrome://`·빈 URL 이면 마감까지 다시 기다리고, 마감 후에도 그러면 `tab_not_ready` 중단. `step.urlContains` 가 있고 URL 에 포함되지 않으면 `tab_url_mismatch` 중단. 이것은 이미 정해진 탭의 검증이지 선택이 아니므로 I2 를 어기지 않는다.
3. 실패 시 주소를 대신 열거나 클릭을 자동으로 반복하지 않는다.
4. `setRunTab`. 활성화 없음.

`openTab{tabRef}` 노드: 기존 생성 코드 뒤 `bindTabRef`. `closeTab{tabRef}` 노드: `resolveTabRef` → 그 탭만 `tabIds` 로 닫고 `closedRefs.add(ref)`, `ownedTabIds.delete(tabId)`. `tabRef` 가 있는데 해석에 실패하면 **현재 run 탭 폴백을 타지 않고** `tab_ref_unbound` 중단(L133-137 의 폴백은 `tabRef` 필드가 없을 때만).

무장되지 않은 시점에 run 소유 탭이 연 탭(사용자가 run 탭에서 직접 링크를 열었거나 페이지 타이머가 연 팝업, Codex C3)

- 어떤 번호에도 묶지 않고 `ownedTabIds` 에 넣지 않는다. 로그에 "예상하지 못한 새 탭이 열렸어요(닫지 않습니다)" 경고만 남긴다. abort 정리 대상도 아니다. 화면 복원(I3b)만 spawn scope 가 한다(2.5).

**모호하면 중단: 오류 코드와 사용자 문구**

| 코드                  | 조건                                              | 사이드패널 문구(한국어)                                                                                    |
| --------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `new_tab_not_opened`  | 기대 무장 후 마감까지 생성 기록 0건               | "이 단계에서 새 탭이 열려야 하는데 열리지 않았어요. 사이트가 팝업을 막았거나 페이지가 바뀌었을 수 있어요." |
| `new_tab_ambiguous`   | 생성 기록 2건 이상                                | "새 탭이 한 번에 여러 개 열려서 어느 탭에서 계속할지 정할 수 없어요. 실행을 멈췄어요."                     |
| `tab_ref_unbound`     | `switchTab`·`closeTab` 의 번호가 아직 묶이지 않음 | "N번 탭이 아직 열리지 않았어요. 앞 단계에서 새 탭을 여는 동작이 빠졌는지 확인해 주세요."                   |
| `tab_ref_conflict`    | 같은 번호 재바인딩·닫힌 번호 재사용·잘못된 번호   | "탭 번호가 겹치거나 잘못됐어요. 이 흐름을 다시 녹화해 주세요."                                             |
| `tab_not_ready`       | 묶인 탭이 마감까지 빈 페이지·로딩 중              | "N번 탭이 아직 준비되지 않았어요. 페이지가 다 열린 뒤 다시 실행해 주세요."                                 |
| `tab_url_mismatch`    | 묶인 탭 URL 이 `urlContains` 를 포함하지 않음     | "N번 탭에 예상과 다른 페이지가 열렸어요. 안전을 위해 여기서 멈췄어요."                                     |
| `expectation_busy`    | 기대가 이미 무장된 상태에서 또 무장               | (내부 오류) "실행 중 문제가 생겨 멈췄어요."                                                                |
| `worker_restarted`    | 워커 재시작으로 run 이 중단됨(2.6)                | "브라우저 확장이 다시 시작되어 실행을 멈췄어요. 자동으로 이어서 실행하지 않아요."                          |
| `tab_scope_violation` | 기존 그대로(번호도 id 도 없음, 소유 밖 id)        | 기존 문구 유지                                                                                             |

중단은 모두 후속 조작 **전에** 일어난다. 중단 뒤에는 기존 abort 정리 경로(`closeOwnedTabs`)가 run 이 만든 것으로 확인된 탭만 닫는다.

### 2.5 spawn scope 와 소유 판정 연결(일반 Run 경로)

**결정: 일반 Run 도 `beginSpawnScope` 를 열되, 소유 판정 연결을 필수로 한다.**

- `SpawnScopeInput` 에 `owns: (tabId: number) => boolean` 을 추가하고 `scopeForOpener` 가 `scope.owns?.(openerTabId) === true || sessionScoped.includes(openerTabId)` 로 판정한다. Run 은 `owns: (id) => id === state.tabRefs.get(0) || state.ownedTabIds.has(id)` 를 넘긴다. 이것이 없으면 `'run::'+runId` 버킷은 비어 있어 보호가 연결되지 않는다(Codex C4). "선택 사항" 이 아니라 필수다.
- 생성 판정은 tracker 의 기록 하나를 두 소비자(spawn scope 의 화면 복원, 재생의 기대 확인)가 같이 쓴다. 재생 기대 확인은 tracker 를 구독할 뿐 자체 `onCreated` 리스너를 달지 않는다.
- 우선순위: 예약 실행이 같은 scheduler 를 통해 흐름을 돌린다면 스코프가 둘 열릴 수 있다. 규칙은 "이미 열린 스코프의 `owns` 가 true 를 돌려주면 그 스코프가 우선이고, Run 은 `options.spawnScopeKey` 가 주어지면 새 스코프를 열지 않고 그 키를 쓴다". schedule-runner 가 scheduler 를 어떻게 부르는지는 이번에 읽지 않았으므로 구현 시 `beginSpawnScope` 호출 지점(조사 B 기준 schedule-runner.ts:904, 1111)에서 키 전달 방식을 확인한다.
- `forced: true`(재생은 전역 토글과 무관하게 무간섭, I3a·I3b).
- 화면 복원(`restoreUserView`)은 흡수 여부와 무관하게, `owns` 가 true 인 opener 에서 나온 모든 생성에 적용한다. 즉 무장되지 않은 시점의 예상 밖 탭도 화면은 되돌린다. 단 **소유 등록·정리는 하지 않는다**(C3).
- 정리 단위: Run 스코프에서는 팝업 **창** 을 통째로 닫지 않는다. `endSpawnScope` 의 창 단위 닫기(조사 B 기준 schedule-runner.ts:550 경로)는 예약 실행 전용으로 남기고, Run 스코프는 `popupWindowIds` 를 채우지 않는다. Run 이 닫는 것은 `closeOwnedTabs` 의 개별 탭 id 뿐이며 abort 때만이다. 정상 종료는 지금처럼 탭을 남긴다.

### 2.6 MV3 워커 종료 정책

- `RunTabState`·기대·큐·스코프는 전부 메모리다. 워커가 죽으면 사라지고 `finalize` 는 보장되지 않는다.
- **정책: 워커 재시작 시 `runState.restore()` 가 `status: 'running'` 인 run 을 발견하면 `stopped` 로 바꾸고 `stopReason: 'worker_restarted'` 를 기록한다. 자동 재개하지 않는다. 열려 있는 탭을 다시 훑어 번호를 붙이는 복구는 하지 않는다.** 사용자에게는 2.4 표의 문구와 함께 "마지막으로 성공한 단계: N" 을 보여준다(`RunState` 에 `lastStepIndex` 를 추가해 단계마다 갱신. 이 필드는 재개용이 아니라 표시용이다).
- 재시작 전 run 이 만들었던 탭은 닫지 않는다(무엇이 run 의 것인지 확인할 수 없기 때문). 사용자가 닫는다.
- `RunState` 에 `stopReason?: string`, `lastStepIndex?: number` 두 필드 추가(state-manager.ts).

### 2.7 실행기 이원화 대응

**결정: 두 실행기를 합치지 않고, 상태는 `RunTabState` 참조 하나를 공유하고 판정은 `engine/tab-context.ts` 의 공통 함수로 한다.**

- `runTabFromId()` 복사 목록에 `tabState: session?.tabState`, `actions/adapter.ts` 컨텍스트 생성에 `tabState: ctx.tabState` 를 추가한다. `RunSessionContext` 에도 같은 필드. 누락되면 actions 경로가 빈 매핑을 보게 되므로, **실제 adapter 를 거쳐** `switchTab{tabRef}` 가 성공하는 테스트를 추가한다(Codex 6).
- `switchTabNode.run` 과 `switchTabHandler.run` 은 `resolveSwitchTarget` + 문서 준비 검증 헬퍼 `verifyTabDocument(tabId, { urlContains, timeoutMs, signal })` 를 같은 순서로 부른다. 차이는 오류 반환 방식뿐(노드는 throw, 핸들러는 `failed(code, message)`).
- 클릭도 마찬가지: 노드와 핸들러가 `armNewTabExpectation`/`settleNewTabExpectation` 을 같은 순서로 부른다.
- 테스트: `run-tab-scope.test.ts` 의 기존 케이스 전부 유지. 새 케이스는 nodes 하나마다 actions 짝을 둔다: `tabRef` 전환 성공, `ref 0` 유효, 미묶임 `tab_ref_unbound`, 재바인딩 `tab_ref_conflict`, 기대 0건·2건 중단, 무장 밖 생성은 소유 안 됨, `closeTab{tabRef}` 가 현재 탭 폴백을 타지 않음, adapter 경유 `tabState` 공유.

### 2.8 구버전 실행 차단과 롤백

- **PR B0(작게, 먼저 배포)**: 흐름 `meta.features` 에 `'multitab'` 이 있거나 단계 어디든 `tabRef`/`opensTab` 이 있으면, 실행 엔진이 `ENGINE_FEATURES` 에 `'multitab'` 을 갖지 않는 한 실행을 시작하지 않고 `flow_requires_newer_engine` 으로 거절한다(문구: "이 흐름은 더 새 버전의 확장에서 만들었어요. 확장을 업데이트한 뒤 실행해 주세요"). 스케줄 실행도 같은 게이트를 지난다. 이 게이트가 있는 버전으로 롤백하면 새 흐름은 실행되지 않을 뿐 엉뚱한 탭을 닫지 않는다.
- 이미 배포된 1.13.0 이하는 게이트가 없다. 그 버전으로 되돌리는 경우(수동 언팩 로드) `closeTab{tabRef}` 가 현재 탭을 닫는 위험이 남는다. 문서로 명시하고, 1.14.0 릴리스 노트에 "1.13 으로 되돌리면 여러 탭 흐름을 실행하지 말 것" 을 적는다. 이보다 나은 방법은 없다(구버전 코드는 바꿀 수 없다).
- **구버전 실행 차단은 필수다(메인 세션 결정).** 흐름 저장 형식에 `meta.features: ['multitab']` 과 `meta.minEngine: '1.14.0'` 을 함께 넣는다. 게이트는 둘 중 하나라도 있으면 `ENGINE_FEATURES`·엔진 버전과 비교해 거절한다. 사이드패널·스케줄·MCP `record_replay_flow_run` 세 진입점이 같은 함수 `assertFlowRunnable(flow)` 를 부른다.
- 기능 플래그 `MULTITAB_ENABLED`(배경 상수): false 면 (a) 녹화가 `tabRef`·`opensTab`·`origin` 을 만들지 않고, 탭 전환은 `switchTab{urlContains}` 만 남기는 1.13 동작으로 돌아간다(사용자가 (가)를 택했으므로 합류 정책 자체는 1.13 과 같다. 바뀌는 것은 `openTab{origin:'joined'}` 자동 기록과 번호 배정뿐이며, 플래그 false 는 그 둘만 끈다). (b) 실행은 B0 게이트로 멀티탭 흐름을 거절한다.
- 단계 롤백: 초판의 1~4단계 분할은 1단계 번호 배정이 2단계 생성 추적에 의존해 독립 롤백이 안 됐다. 이번에는 "안전한 최소 단위" 하나(2.9 의 M1)에 생성 원인 기록·매핑·합류 제한·종료 처리를 함께 넣고, M2·M3 은 그 위의 독립 추가로만 둔다.

사용자 탭이 끌려 들어올 수 있는 경로와 차단(정리)

- 녹화: 사용자 결정으로 활성화한 탭은 모두 들어온다. 차단 장치는 (1) 주입 불가 URL 제외, (2) "입력한 글자 가리기" 를 세션 전체에 적용, (3) 페이지 막대에 값 미표시, (4) 타임라인·카드에서 어느 탭이 들어왔는지 보이게 하는 것이다. 무관한 탭이 들어오는 것 자체는 막지 않는다.
- 재생: 소유·번호 묶기는 `openTab` 과 무장된 기대 두 경로뿐. `openerTabId` 단독 판정 없음. URL 은 검증에만 쓴다. 활성화 없음.
- 정리: abort 시 `ownedTabIds` 의 개별 탭만. 창 단위 닫기 없음. 정상 종료는 탭을 남긴다.

### 2.9 단계별 구현 순서

시연 페이지: `https://example.com/` 과 로컬 파일 `file:///.../multitab-demo.html`(example.com 으로 가는 `target=_blank` 링크 1개, `window.open('https://example.com/')` 버튼 1개, 두 탭을 한 번에 여는 버튼 1개). 외부 사이트는 쓰지 않는다.

**M0(PR B0): 구버전 실행 차단 게이트**

- 합격: `meta.features: ['multitab']` 흐름을 게이트 없는 엔진 상수로 실행하면 `flow_requires_newer_engine`, 있는 엔진이면 통과. 테스트로 고정.

**M1(PR B 최소 단위): 생성 원인 기록 + 매핑 + 합류 제한 + 종료 처리**

- 범위: 스키마 6필드(`tabRef` 3곳, `origin`, `opensTab` 2곳), `RunTabState`·공통 함수·adapter 연결, 단일 기록 큐, `_blank` 분기 `tabRef` 배정, `opensTab` 사후 부착, 합류 시 `openTab{origin:'joined'}` 자동 기록 + 주입 불가 URL 제외 + "입력한 글자 가리기" 세션 전체 적용, 클릭 노드 기대 무장·확인, `switchTab` 문서 준비 검증, `closeTab{tabRef}`(폴백 차단 포함), 워커 재시작 중단, Run spawn scope + `owns` 연결, 오류 문구 9종, 저장 시 "n번 탭을 여는 단계 없음" 검증.
- 합격: (a) 데모 페이지 세 시나리오(`_blank` 링크 / `window.open` 버튼 / 두 탭 버튼) 녹화 후 재생하면 앞 둘은 성공하고 셋째는 `new_tab_ambiguous` 로 **클릭 다음 단계 전에** 멈춘다. (b) 기존 `run-tab-scope`·`tab-cursor` 테스트 전부 통과 + 2.7 의 새 테스트 통과. (c) 재생 중 사용자가 run 탭에서 직접 링크를 새 탭으로 열어도 그 탭은 소유·번호·정리 대상이 아니고 화면은 원래 탭으로 돌아온다(수동 시연 + 로그 확인). (d) 녹화 중 미리 열어 둔 example.com 탭을 누르면 막대가 뜨고 타임라인에 "새 탭 열기: example.com" 과 "N번 탭으로 이동" 이 차례로 생기며, 재생하면 example.com 이 백그라운드 새 탭으로 열려 이어진다. (e) 녹화 중 `chrome://extensions` 탭을 눌러도 단계가 생기지 않고 사이드패널에 "녹화할 수 없는 페이지" 안내가 뜬다.
- 시연: 데모 → 녹화(버튼 클릭 → 새 탭에서 "More information" 클릭 → 새 탭 닫기) → Run → 새 탭이 백그라운드로 열리고 닫히며 사용자 화면이 바뀌지 않고 성공. 그 뒤 확장 서비스 워커를 `chrome://serviceworker-internals` 에서 종료시키고 다시 Run 도중 종료 → 사이드패널에 `worker_restarted` 문구, 탭은 남는다.

**M2: 표시와 편집**

- 범위: 카드 라벨·타임라인 라벨·Builder 스펙 필드·"자동으로 열린 탭" 표식·유효성 오류 문구.
- 합격: 사이드패널 카드와 페이지 막대에서 탭 단계가 번호로 읽히고, 잘못된 번호 저장이 거절된다. 한자 0·대시 0.

**M3: 확장(선택)**

- 범위: 한 동작에 여러 탭(`opensTab` 배열, 각 기대에 `urlContains` 필수로 구분), 키보드 Enter 로 새 탭이 열리는 경우의 원인 단계 지원.
- 합격: 데모 "두 탭 버튼" 이 `urlContains` 로 구분되는 경우에만 성공하고 같은 주소면 여전히 `new_tab_ambiguous`.

---

## 3부. 공통

### 3.1 작업 순서·의존·PR·버전

- PR A(도구 막대): `recorder.js`(UI·문구·Shadow DOM), 로케일 ko·en, `session-manager.ts broadcastTimelineUpdate`. 먼저 머지.
- PR B0(게이트): 실행 시작 지점 + schedule-runner 시작 지점 + 테스트. 아주 작다. A 와 독립.
- PR B(M1): `recorder.js`(`_blank` 분기·타임라인 라벨의 tabRef 표시·가리기 설정 동기화), `session-manager.ts`(큐·tabRefs·payload), `browser-event-listener.ts`, `legacy-types.ts`, `engine/tab-context.ts`, `engine/scheduler.ts`, `engine/state-manager.ts`, `nodes/tabs.ts`, `nodes/click 계열`, `actions/handlers/tabs.ts`·클릭 핸들러, `actions/adapter.ts`, `utils/spawned-tab-tracker.ts`, 사이드패널 카드 부제·"녹화할 수 없는 페이지" 상태줄·저장 검증, 테스트.
- **파일 겹침(초판 정정)**: `recorder.js` 와 `session-manager.ts` 는 A 와 B 가 함께 만진다. 따라서 A 머지 후 B 리베이스가 순서다. B 안에서 `recorder.js` 변경은 `_onClick` 의 `_blank` 분기(L1226-1236)와 `_formatStepText` 의 탭 라벨 두 곳으로 한정해 충돌 면적을 줄인다.
- 버전: A·B0·B 가 모두 들어간 시점에 1.14.0. B0 만 먼저 나가야 한다면 1.13.1 로 게이트만 내보내는 선택지도 있다(롤백 안전성이 높아진다).
- Codex 교차 검증: M1 구현 전에 2.1~2.5 를 다시 Codex 에 보내 이 개정판 기준으로 재검토 받는다. 보안 제약 영역이라 독립 검토가 규칙이다.

### 3.2 모델 배정 권고

| 단위                                                                                    | 모델                         | 이유                        |
| --------------------------------------------------------------------------------------- | ---------------------------- | --------------------------- |
| A1. 로케일 키 + `t()` 헬퍼(폴백 치환 포함) + 한자 치환                                  | sonnet                       | 표 확정, 검증 파이썬 한 줄  |
| A2. closed Shadow DOM 이전 + createElement 화 + 토큰 + 접기·귀퉁이·키보드 이동 + 재부착 | sonnet                       | 단일 파일, 합격 기준 명확   |
| A3. payload 확장 + 값 제거 요약 + 시계                                                  | sonnet                       | 두 파일                     |
| A4. PR A 실기기 검증(격리·CSP·접근성·민감값)                                            | sonnet 수집 → opus 판정      | 표본 검사                   |
| B0. 게이트                                                                              | sonnet                       | 작고 기계적                 |
| B1. `RunTabState`·공통 함수·adapter 연결·클릭 기대·switchTab 검증·closeTab 폴백 차단    | opus                         | 보안 불변식 핵심            |
| B2. 단일 기록 큐·합류 규칙·`_blank` 분기·`opensTab` 사후 부착                           | opus                         | 이벤트 순서·프라이버시 판정 |
| B3. spawn scope `owns` 연결·워커 재시작 정책                                            | opus                         | 두 소유 체계 연결           |
| B4. 테스트 작성(2.7 목록)                                                               | sonnet, 판정 opus            | 케이스가 열거돼 있음        |
| B5. 카드·타임라인 라벨·Builder 스펙·문구                                                | sonnet                       | 정해진 문구 반영            |
| Codex 재검토                                                                            | Codex                        | 과금 0, 규칙                |
| 최종 검수                                                                               | sonnet 증거 수집 → opus 판정 | 납품물 아님                 |

### 3.3 사용자에게 물을 것

1. (확정됨) `tabRef` 선택 필드 추가는 1.14.0 에 넣고 구버전 실행 차단은 필수로 한다. 합류 규칙은 (가) 그대로 두기. 더 물을 것 없음.
2. "입력한 글자 가리기" 의 기본값을 켜짐으로 바꿀지. (가)에서 무관한 탭의 입력이 녹화될 수 있으므로 켜짐이 안전하지만, 켜면 모든 입력이 변수로 저장돼 재생 전에 값을 채워야 하는 흐름이 늘어난다.
3. B0 게이트만 1.13.1 로 먼저 내보낼지.

### 3.4 검토 의견 중 채택하지 않은 것

- **Codex 중요 4: "자동 합류를 세션 시작 이후 생성이 확인된 세션 자식 탭으로 좁혀라"**: 채택하지 않는다. 사용자가 프라이버시 설명을 듣고 편의 쪽인 "(가) 그대로 두기" 를 확정했다(2026-09-09). 사용자 결정이 우선한다. 대신 4-(c)가 지적한 "재생에서 생성 수단이 없는 ref" 문제는 합류 시 `openTab{origin:'joined'}` 자동 기록으로 푼다(2.3). 4-(b)의 `shouldJoinSession` 생성 시점 구멍은 `onCommitted` 경로에 한해 막는다.
- **`expectNewTab` 을 별도 단계로 두는 안**: Codex 는 "원인 단계에 연결" 이라고만 했고 형태를 정하지 않았으나, 별도 단계 해석은 채택하지 않는다. 클릭 필드로 두어야 무장과 판정이 같은 실행 단위에서 끝나고 편집으로 짝이 깨지지 않는다(2.2).
- **워커 재시작 후 "저장된 초안 제공"(run 에 대해)**: run 에는 초안 개념이 없다. 대신 `lastStepIndex` 를 표시한다. 초안 저장은 녹화 세션에만 적용한다(2.3).
- **`a[target=_blank]` 도 클릭 + 기대로 통일하자는 방향**: 채택하지 않는다. href 가 http(s) 인 링크는 주소 직접 열기가 결정적이고 모호성이 0 이며, 지금 녹화기의 변환이 이미 그 방향이다. 기대 방식은 예측 불가한 생성에만 쓴다(2.2). Codex 도 "클릭과 openTab 을 함께 재생해 중복 생성하지 않겠다는 판단" 은 유지하라고 했다.
- **초판의 "정상 종료 시 run 이 만든 탭 닫기"**: Codex 지적을 받아들여 철회한다. 기존 동작(정상 종료는 탭을 남김, abort 만 닫음)을 유지한다. 이것은 반박이 아니라 초판 제안의 철회다.

---

## 이 설계가 실패인 조건(3줄)

1. 재생에서 탭 번호가 `openTab{tabRef}` 와 무장된 `opensTab` 기대 밖의 경로(생성 순서 카운터, `openerTabId` 단독, URL 검색)로 묶이거나, `resolveTabRef` 결과가 소유 검사 없이 쓰이면 실패다.
2. 2.9 M1 의 세 시나리오 중 앞 둘이 성공하지 못하거나, 셋째가 클릭 다음 단계를 실행한 뒤에야 멈추면 실패다(모호하면 후속 조작 전에 중단).
3. 구버전 게이트 없이 `tabRef` 를 만드는 코드가 먼저 배포되거나, 도구 막대·타임라인에 한자·대시류·입력값이 남으면 실패다.

---

## 개정 이력

- 2026-09-09 초판 → 같은 날 Codex(gpt-6-astra) 교차 검증 반영 개정.
- 재생 쪽 생성 순서 카운터를 없애고 "원인 단계(`openTab`·클릭 `opensTab`)에 기대를 붙이고 모호하면 중단" 모델로 2부를 다시 썼다(C1·C2). `recorder.js` `_blank` 분기가 클릭을 남기지 않는 사실과 `closeTabNode` 의 현재 탭 폴백을 반영해 `_blank` 처리·구버전 게이트(B0)·롤백 절을 고쳤다.
- `openerTabId` 단독 소유 판정 폐기, 정리는 개별 탭 id 기준, spawn scope 의 `owns` 연결을 필수로(C3·C4). I3 를 I3a/I3b 로 분리.
- MV3 워커 종료(중단·비재개), 문서 준비 검증, 단일 기록 큐, `RunTabState` 공유, 구버전 차단(필수, `meta.features` + `meta.minEngine`)을 각각 절로 추가.
- 합류 규칙은 사용자 확정에 따라 "(가) `onActivated` 무조건 합류 그대로" 로 되돌리고, 그 대신 세션 자식 탭이 아닌 탭이 합류하면 `openTab{origin:'joined'}` 를 자동 기록하도록 했다. 주입 불가 탭 제외, 로그인 의존 탭의 한계, "입력한 글자 가리기" 기본값(꺼짐, L460) 확인을 함께 적었다.
- 1부: closed Shadow DOM·host 초기화·`remove()` 대상·시트 실패 처리·CSP/Trusted Types 확인 항목·페이지 막대 민감값 제거·폴백 치환·`default_locale: ko` 확정·접근성 검증 항목 추가. 문구 21개 표는 그대로.

---

## 읽은 파일(직접 확인)

- `app/chrome-extension/inject-scripts/recorder.js` L185-320, L418-450, L876-886, L1215-1245
- `app/chrome-extension/entrypoints/background/record-replay/recording/browser-event-listener.ts` L120-240
- `app/chrome-extension/entrypoints/background/record-replay/recording/session-manager.ts` L195-210, L810-845
- `app/chrome-extension/entrypoints/background/record-replay/nodes/tabs.ts` L1-150
- `app/chrome-extension/entrypoints/background/record-replay/actions/handlers/tabs.ts` L115-175(및 grep)
- `app/chrome-extension/entrypoints/background/record-replay/actions/adapter.ts` L105-135
- `app/chrome-extension/entrypoints/background/record-replay/legacy-types.ts` L190-215
- `app/chrome-extension/entrypoints/background/record-replay/rr-utils.ts` L145-210
- `app/chrome-extension/entrypoints/background/record-replay/engine/tab-context.ts` L355-400(및 export grep)
- `app/chrome-extension/entrypoints/background/record-replay/engine/scheduler.ts` L387-425, L960-985
- `app/chrome-extension/entrypoints/background/record-replay/engine/state-manager.ts` L1-30
- `app/chrome-extension/utils/work-tab-gate.ts` L40-90
- `app/chrome-extension/utils/spawned-tab-tracker.ts` L25-60, L220-236, L236-310, L425-460(및 export grep)
- `app/chrome-extension/tests/record-replay/run-tab-scope.test.ts`, `tab-cursor.integration.test.ts` (테스트 이름만 grep)
- `app/chrome-extension/wxt.config.ts` (`default_locale` grep)

읽지 않은 것(조사 결과·Codex 인용만): `node-specs-builtin.ts`, `card-format.ts` 본문, `useRecorder.ts`, `content-injection.ts`, `ui/theme.css`, 로케일 messages.json 본문, `rr-graph.ts`(경로에서 찾지 못함), `session-manager.ts start()` 본문, `schedule-runner.ts`, 클릭 노드·핸들러 본문, `work-tab-manager.ts`.
