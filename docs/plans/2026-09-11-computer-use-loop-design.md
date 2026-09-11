# computer use 실행 루프 (2026-09-11)

브랜치 `feat/computer-use-loop`. 커밋 `12177ba`(1단계), `1992c46`(2단계). `66ec4ea` 에서 분기, 미푸시.

이 문서는 **다음에 이 코드를 열 사람을 위한 것**이다. 무엇을 왜 그렇게 했는지, 어디를 건드리면 무엇이 깨지는지, 다음에 무엇을 해야 하는지를 적는다.

---

## 1. 왜 했나

질문은 "ChatGPT·Codex 의 computer use 기능을 이 저장소에 똑같이 구현할 수 있는가" 였다. Codex 에게 저장소를 읽히고 검토시킨 결과 판정은 **부분적으로만 가능**이었다.

- **(A) 브라우저 안**에서 화면을 보고 좌표로 조작하는 루프: 기본 재료는 이미 `chrome_computer` 에 있었다. 신뢰성이 빠져 있었다. **이번에 이것을 구현했다.**
- **(B) 브라우저 밖 PC 제어**(다른 앱, 네이티브 파일창, 바탕화면, 주소창): 확장과 CDP 로는 **원리적으로 불가능**하다. 이번 작업 범위가 아니다. 3절에 판정 근거를 남긴다.

## 2. 무엇이 문제였나 (작업 전 상태)

1. **좌표를 줘도 실제 입력이 CDP 가 아니었다.** `left_click` 등이 `coordinates` 만 받아도 `clickTool.execute()`(content script 합성 이벤트)를 먼저 쓰고 CDP 는 폴백이었다. 픽셀로 목표를 정해 놓고 실행은 DOM 이라, 실제 브라우저 입력과 이벤트 처리가 달랐다.
2. **스크린샷과 그 뒤 클릭 사이에 화면이 바뀌어도 통과했다.** 검사는 hostname 변경 하나뿐이었다. 같은 도메인 안의 페이지 이동·스크롤·리사이즈는 그대로 통과했다.
3. **좌표 컨텍스트가 메모리에만 있었다.** MV3 서비스 워커가 재시작되면 사라지고, 만료되면 좌표를 조용히 CSS 좌표로 취급했다.
4. **액션이 성공을 반환해도 화면에서 그 일이 일어났다는 뜻이 아니었다.** 모델이 매번 따로 스크린샷을 요청해야 했고, 그마저 화면이 아직 움직이는 중일 수 있었다.
5. **표현할 수 없는 입력이 있었다.** 버튼 누름과 해제 분리, 키 유지, 경로 드래그, IME 조합.

작업 전 조사에서 **사실이 아닌 것으로 판명된 것 셋**(같은 오해를 반복하지 말 것):

- "ref·selector 만 DOM 우선이다" → 틀렸다. 좌표 경로도 DOM 우선이었다.
- "브리지에는 프로세스 실행이 없다" → 틀렸다. `app/native-server/src/security/auth-token.ts` 가 토큰 파일 ACL 잠금에 `whoami` 와 `icacls` 를 실행한다.
- "스크린샷 배율 처리에 DPR 보정이 빠졌다" → 틀렸다. `screenshot.ts` 가 모델이 실제로 보는 축소본의 픽셀 크기를 좌표 컨텍스트에 기록하므로 DPR 을 따로 곱할 필요가 없다.

## 3. (B) 를 하지 않은 이유 (재론 시 여기부터)

- CDP `Input` 은 페이지에 이벤트를 전달한다. 좌표는 메인 프레임 뷰포트의 CSS 픽셀이다. 다른 앱·바탕화면·네이티브 파일창·주소창·탭 스트립에 대한 범용 OS 입력 API 가 아니다.
- 확장의 `desktopCapture` 로 **화면 관찰은 가능**하다. 캡처 권한이 입력 권한을 주지는 않는다. 보는 것과 누르는 것은 분리돼 있다.
- 브리지는 확장 샌드박스 밖의 Node 프로세스다. 그래서 (B) 는 "확장 권한을 늘리는 문제" 가 아니라 **"브리지 옆에 OS 실행기를 새로 붙이는 문제"** 다. 권장 경로는 `app/desktop-agent/` 에 별도 실행기를 두고 인증된 named pipe 로 통신하는 것. 화면 간섭을 피해야 하면 VM.
- 일반 권한 `SendInput` 은 더 높은 무결성 수준으로 도는 앱에 입력하지 못한다. UAC 보안 데스크톱과 로그온 화면은 어떤 방식으로도 불가능하다.
- **기존 안전장치는 (B) 에서 전부 무효다.** 작업 탭 게이트·탭 리스·자동화 가드는 모두 탭 단위다. OS 입력에는 별도 동의 범위, 창 허용목록, 사용자 개입 시 중단, 비상정지, 입력 해제 watchdog 이 새로 필요하다.

## 4. 무엇을 만들었나

### 4.1 좌표 실행 (1단계)

- **좌표만 준 경우 CDP `Input` 우선.** 대상 액션: `left_click`, `right_click`, `double_click`, `triple_click`, `left_click_drag`, `hover`.
- **`ref`·`selector` 가 있으면 지금까지처럼 DOM 우선.** 이건 의도된 설계다. 되돌리지 말 것.
- 결과 JSON 에 `transport`(`cdp` | `dom` | `dom-ref`)와 폴백 시 `transportFallbackReason` 을 싣는다.

**폴백 경계가 이 작업에서 가장 중요한 결정이다.** `runCoordinateCdp()` 가 dispatch 호출 **직전에** `attempted = true` 를 세우고, 실패 시 `canFallback: !attempted` 를 돌려준다. 즉 **전송을 한 번이라도 시도한 뒤의 실패는 DOM 으로 재시도하지 않는다.** `mousePressed` 가 브라우저에 전달됐는지 알 수 없는 상태에서 DOM 으로 다시 누르면 같은 버튼이 두 번 눌린다(주문 중복 제출 같은 사고). 그 경우 `partiallyDeliveredError()` 로 "입력이 일부 전달됐을 수 있음" 을 명시해 돌려준다.

눌린 버튼·키가 있는 동안에도 폴백을 막는다(`canFallback: !attempted && !computerInputState.hasHeldInput(tabId)`). DOM 합성 이벤트는 CDP 가 쥐고 있는 눌림 상태를 모른다.

### 4.2 관찰 (1단계)

스크린샷 한 장이 곧 **관찰 1건**이다. `observationId` 로 식별하고 다음을 함께 기록한다.

- 좌표계(`coordinateSpace`), 캡처 영역의 원점과 크기, 모델이 보는 이미지의 픽셀 크기
- 캡처 시점의 `scrollX`·`scrollY`, 뷰포트 CSS 크기
- 문서 세대(URL 과 내비게이션 시점)

`chrome_computer` 가 `observationId` 를 받으면 **입력을 보내기 전에** 검증하고, 어긋나면 실행하지 않고 거부한다. 거부 사유는 `not_found`, `expired`, `tab_changed`, `metadata_unavailable`, `document_changed`, `scroll_changed`, `viewport_changed` 일곱 가지이며, 메시지에 "새 스크린샷을 찍고 다시 시도하라" 를 붙인다.

`observationId` 를 주지 않으면 기존 동작을 유지한다(하위 호환). 다만 컨텍스트가 없거나 만료된 상태에서 좌표를 CSS 좌표로 간주해 실행하면 결과에 경고를 붙인다. 예전처럼 조용히 넘어가지 않는다.

**관찰은 `chrome.storage.session` 에 보존한다.** 서비스 워커가 재시작돼도 좌표의 의미가 조용히 바뀌지 않게 하기 위해서다. 좌표 액션 진입 시 `screenshotContextManager.restore()` 로 복구한다.

### 4.3 액션 후 재관찰과 안정화 (2단계)

`observeAfter: true` 를 주면 액션 뒤 화면이 멈출 때까지 기다렸다가 **새 관찰을 만들어 그 `observationId` 를 결과에 실어 준다.** 모델은 그 id 로 곧장 다음 좌표 액션을 낼 수 있다. **기본값은 꺼짐**이다(매 액션마다 캡처 비용이 들기 때문). `includeImage: true` 를 함께 주면 안정화된 이미지도 붙는다.

안정화 판정 상수는 `utils/computer-stabilization.ts` 맨 위에 근거 주석과 함께 모여 있다.

| 상수                                         | 값   | 이유                                                  |
| -------------------------------------------- | ---- | ----------------------------------------------------- |
| `STABILIZATION_SAMPLE_INTERVAL_MS`           | 150  | 한 프레임 이상 그릴 시간을 주되 루프 지연은 짧게      |
| `STABILIZATION_MAX_WAIT_MS`                  | 2500 | 계속 움직이는 페이지에서 한 액션이 오래 붙잡히지 않게 |
| `STABILIZATION_FINALIZATION_RESERVE_MS`      | 600  | 상한에 걸려도 유효한 관찰 ID 를 만들어 돌려주려고     |
| `STABILIZATION_MAX_SAMPLE_EDGE`              | 64   | 비교 비용 제한, 화면 전역의 큰 움직임은 보존          |
| `STABILIZATION_DIFF_THRESHOLD`               | 0.01 | 축소·압축의 미세한 색 흔들림 무시                     |
| `STABILIZATION_REQUIRED_CONSECUTIVE_MATCHES` | 2    | 우연한 동일 프레임 한 번을 안정으로 오인하지 않게     |

결과의 `stabilization.status` 는 `stable` | `timeout` | `skipped`. 캡처가 막힌 탭에서는 오류로 죽이지 않고 `skipped` 로 표시한다. 상한에 걸리면 `timeout` 으로 표시하고 **그래도 관찰은 돌려준다.**

### 4.4 범용 입력과 눌린 상태 (2단계)

새 액션: `mouse_down`, `mouse_up`, `key_down`, `key_up`, `drag_path`(2~1000 점), `ime_type`. 기존 `type` 의 `Input.insertText` 동작은 그대로 두었다. `ime_type` 은 `Input.imeSetComposition` 으로 조합한 뒤 commit 하며, commit 만 실패하면 남은 조합 밑줄을 best effort 로 취소한다.

**이 기능의 진짜 위험은 눌린 상태가 남는 것이다.** 모델 호출이 중간에 실패했는데 버튼이나 키가 눌린 채 남으면 사용자의 손 조작까지 망가진다. `utils/computer-input-state.ts` 가 다음을 책임진다.

- 탭별로 눌린 버튼·키 추적, 저장소 보존(워커 재시작 복구)
- **10초 watchdog 자동 해제**(`HOLD_WATCHDOG_MS`, chrome.alarms). 조합키·드래그에 수 초를 허용하되 실패한 호출이 사용자 입력을 계속 붙잡지 않게 하는 값이다
- 액션 오류·탭 이동·문서 변경·세션 종료 시 정리(`releaseAll`)
- 개별 CDP 명령에 2초 마감(`COMMAND_DEADLINE_MS`)을 두어 응답이 멎어도 복구 큐가 진행된다
- 충돌 정책(`guardAction`). 세 갈래이며 스키마 설명보다 이쪽이 정확하다.
  - **복구 대기 중**(해제 큐가 돌고 있거나 watchdog 마감이 지난 탭): `wait`·`screenshot`·`zoom` 만 통과하고 나머지는 "해제될 때까지 기다려라" 로 거절
  - **버튼이 눌린 동안**: `hover`·`wait`·`screenshot`·`zoom`·`mouse_up`·`key_down`·`key_up` 만 허용. 클릭·드래그 등은 거절
  - **키만 눌린 동안**: 순수 좌표 액션은 허용. 그 밖에 `wait`·`screenshot`·`zoom`·`key_down`·`key_up`·`mouse_down`·`drag_path`·`hover` 도 허용. 나머지는 거절
  - 즉 **읽기 성격의 액션과 해제 경로는 항상 열려 있고**, 눌린 채로 새 클릭을 겹쳐 넣는 것만 막는다

## 5. 파일 지도

| 파일                                                   | 역할                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `app/chrome-extension/utils/screenshot-observation.ts` | 관찰 레코드 타입, `validateObservation()`(거부 사유 판정), 좌표 투영, `readObservationPageState()`   |
| `app/chrome-extension/utils/screenshot-context.ts`     | 관찰·좌표 컨텍스트 저장소. `chrome.storage.session` 보존과 `restore()`                               |
| `app/chrome-extension/utils/computer-loop-contract.ts` | 병렬 작업용 공유 계약. 좌표·버튼 타입, `ExtendedInputAction`, `ComputerObservationResult`            |
| `app/chrome-extension/utils/computer-stabilization.ts` | 안정화 판정과 `observeAfterAction()`. 상수와 근거 주석                                               |
| `app/chrome-extension/utils/computer-input-state.ts`   | 확장 입력 액션 실행(`execute`), 눌린 상태 추적·watchdog·해제(`releaseAll`), 충돌 정책(`guardAction`) |
| `.../tools/browser/computer.ts`                        | 도구 경계. 좌표 검증·투영·CDP 우선 실행·폴백 경계를 소유. 확장 입력은 `computerInputState` 로 위임   |
| `.../tools/browser/screenshot.ts`                      | 캡처 시 관찰 생성, 결과에 `observationId` 포함                                                       |
| `packages/shared/src/tools.ts`                         | 도구 스키마                                                                                          |

`computer.ts` 안의 처리 순서(심볼로 찾을 것, 줄 번호는 바뀐다):

1. `computerInputState.ready()` → `guardAction()` 로 눌린 상태 충돌 검사
2. 좌표 대상이면 `screenshotContextManager.restore()`
3. `observationId` 가 있으면 `validateObservation()` → 실패 시 **입력 없이 즉시 반환**
4. `project()` 로 좌표 변환(관찰이 있으면 관찰 좌표계, 없으면 기존 컨텍스트)
5. 확장 입력 액션이면 `computerInputState.execute()` 로 위임
6. 순수 좌표 액션이면 `executePureCoordinateAction()` → `runCoordinateCdp()`
7. 오류면 `hasHeldInput()` 확인 후 `releaseAll()`
8. `observeAfter` 면 `observeAfterAction()` 결과를 병합(앞선 이미지 블록은 제거하고 관찰 이미지만 붙인다. 다른 이미지의 좌표를 새 ID 로 보내는 사고를 막는다)

## 6. 스키마 변경 (브리지 재발행 필요)

`packages/shared/src/tools.ts` 가 두 커밋에서 바뀌었다. **버전·태그·발행은 하지 않았다.**

`chrome_computer` 추가 파라미터: `observeAfter`, `includeImage`, `button`, `path`, `observationId`, `key`. `action` 열거에 6개 추가. `chrome_screenshot` 설명에 `observationId` 안내 추가.

새 도구 스키마는 브리지를 다시 발행해야 MCP 클라이언트에 보인다. 이 저장소의 선례상 스키마 변경은 버전 상승과 `npm i -g` 갱신을 동반한다.

## 7. 검증

분기 시점 숫자는 **옛 기록에서 옮긴 것이 아니라 2026-09-11 에 `66ec4ea` 를 직접 체크아웃해 다시 측정한 값이다.**

| 항목                         | 분기 시점(66ec4ea) | 현재(1992c46)       |
| ---------------------------- | ------------------ | ------------------- |
| 확장 vitest                  | 110파일 1436건     | **120파일 1572건**  |
| 브리지 jest                  | 236건              | **236건**           |
| `vue-tsc --noEmit` 기존 오류 | 46건               | **46건**(늘지 않음) |

명령(윈도우, pnpm 은 PATH 에 없다):

```
cd app/chrome-extension && .\node_modules\.bin\vitest.CMD run
cd app/chrome-extension && .\node_modules\.bin\vue-tsc.CMD --noEmit   # 종료 코드 2, 오류 46건이 정상
cd app/native-server   && .\node_modules\.bin\jest.CMD
```

커밋 훅(lint-staged)이 eslint --fix 와 prettier 를 적용하므로 **커밋 뒤 최종 상태로 테스트를 한 번 더 돌릴 것.**

## 8. 아직 안 한 것

- **실기기 확인을 전혀 하지 않았다.** 전부 자동 테스트와 코드 확인이다. 9절 체크리스트를 사람이 돌려야 한다.
- 브리지 재발행, 버전 상승, 태그, 푸시, PR, 확장 배포본 갱신.
- (B) 브라우저 밖 PC 제어. 설계 문서도 없다.
- `docs/TOOLS.md` 는 이번에 갱신했으나, 사용설명서(`docs/manual/`)는 손대지 않았다. 화면이 바뀐 것은 없어서 재캡처는 불필요하다.

## 9. 실기기 확인 체크리스트 (사람 필요)

1. 좌표 6개 액션이 실제로 CDP 로 나가는지(결과의 `transport` 가 `cdp`).
2. DevTools 를 열어 둔 탭에서 CDP attach 가 막힐 때 DOM 폴백이 도는지, 그때 `transportFallbackReason` 이 붙는지.
3. 스크롤·새로고침·창 크기 변경 뒤 옛 `observationId` 로 클릭하면 거부되는지(사유 문자열 확인).
4. `chrome://serviceworker-internals` 에서 워커를 종료한 뒤 직전 관찰이 살아 있는지.
5. `mouse_down` 후 10초 두면 버튼이 저절로 놓이는지. 놓인 뒤 페이지가 정상 동작하는지.
6. `ime_type` 으로 한글이 조합돼 입력되는지(조합 이벤트를 듣는 입력창에서).
7. 축소된 스크린샷·전체 페이지 캡처·요소 캡처에서 실제 클릭 위치가 맞는지(고배율 모니터 포함).
8. `observeAfter: true` 를 애니메이션이 계속 도는 페이지에서 호출했을 때 2.5초 안에 돌아오고 `stabilization.status` 가 `timeout` 인지.

## 10. 다음에 이 코드를 건드릴 때 주의

- **폴백 경계를 느슨하게 만들지 말 것.** "CDP 실패했으니 DOM 으로 한 번 더" 는 중복 클릭을 만든다. `attempted` 플래그의 위치(dispatch 직전)를 옮기지 말 것.
- **`ref`·`selector` 경로를 CDP 로 바꾸지 말 것.** 접근성 트리 기반 지정은 DOM 경로가 맞다.
- **`observeAfter` 를 기본값 켜짐으로 바꾸지 말 것.** 모든 액션이 캡처 비용을 물게 된다.
- 안정화 상한을 늘릴 때는 한 액션이 붙잡는 최대 시간을 다시 계산할 것. `FINALIZATION_RESERVE` 와의 관계가 있다.
- watchdog 시간을 늘리면 실패한 호출이 사용자 입력을 붙잡는 시간이 그만큼 늘어난다.
- 이 브랜치는 `feat/recorder-toolbar-and-flow-gate`(멀티탭 1.14.0, 미배포·재검증 대기)와 별개다. 머지 순서를 먼저 정할 것.
