# 사이드패널 2단계: 매일 작업 한 화면 (2026-09-05)

1단계(`2026-09-05-sidepanel-stage1-design.md`, PR #1) 위에 얹는다. 사용자 결정은 그대로: 구버전 빌더 폐기(3단계), **예약은 chrome_shortcut 예약 엔진 하나로 통일**. 브랜치 `feat/sidepanel-stage2`.

## 조사 결과 (2026-09-05, 설계 근거)

- 예약 엔진: `utils/shortcut-schedule.ts`(레코드·저장소, 키 `mcpShortcutSchedules`, 알람 `mcp-shortcut::<name>`) + `entrypoints/background/schedule-runner.ts`(알람 → 큐 → 잠금 → `executeScheduledRun` → 이력 → 실패 알림). `ScheduleRecord.name` 이 곧 단축 이름이라 **대상이 단축으로 고정**. 실행은 `loadShortcuts()[name]` 을 읽어 `runSteps`.
- 예약 이력: `utils/shortcut-history.ts`, 키 `mcpShortcutHistory`, `{[name]: RunRecord[]}`, 상태 9종, `screenshot`(다운로드 폴더 `mcp-screenshots/YYYY-MM-DD/failure_<name>_<HHmmss>.png` 파일명), `results`, `failedStep`, `error`. 단축당 100건·전체 1000건·3MiB.
- 흐름 수동 실행 이력: `flow-store.ts` `appendRun/listRuns`, IndexedDB `rr_storage.runs`, 흐름당 10건, 실패 스크린샷은 `entries[last].screenshotBase64`(파일 아님). 변경 방송 없음(사이드패널이 5초 폴링).
- 흐름 실행 본체: `tools/record-replay.ts` `FlowRunTool.execute`(발행 흐름만, 작업 탭 게이트, startUrl 자동 탭, `createTimeoutAbort`, `runFlow(flow, runTab, options)` → `summarizeRunResult`). 예약 엔진에서 부르려면 이 로직을 도구 껍데기와 분리해야 한다.
- record-replay 자체 예약(`RR_SCHEDULE_FLOW`, `FlowSchedule`, 별도 알람군)은 UI 없이 코드만 있었다. **삭제됨(2026-09-06, 3단계)**. 알람 이름이 shortcut 알람과 겹치지 않는 것은 확인했고, 남아 있던 `rr_schedule_*` 알람은 백그라운드 시작 시 한 번 지운다.
- 가져오기: `flow-store.importFlowFromJson(json)` 이 배열/`{flows}`/단일 흐름을 받아 `saveFlow` 로 덮어씀(id 충돌 처리 없음). `RR_IMPORT_FLOW` 핸들러 있음, 사이드패널 래퍼 없음.
- 알림: `schedule-runner.ts` 예약 실패 알림(한국어 제목) 있음, 클릭 동작 없음.
- 사이드패널: 탭 2개(workflows, element-markers). 카드에 예약·다음 실행 정보 없음. 실행 이력은 접이식 안 최근 5건.
- daily-automation 설계 11절 "하지 않을 것"(브리지 스케줄러, 크롬 밖 실행, cron 문법, 비밀번호 저장, 예약 병렬 실행, 놓친 실행 따라잡기, 자동 재시도)은 그대로 지킨다.

## 목표 사용 절차 (합격 기준의 뼈대)

1. 사이드패널에 **매일 작업** 탭이 있다. 목록 한 줄에 이름, 종류(흐름/단축), 예약 요약("매일 08:00", "월수금 09:30", "6시간마다"), 다음 실행 시각, 마지막 결과(성공/실패/로그인 필요 + 시각), 켜기/끄기 스위치가 보인다.
2. 흐름 카드의 **예약** 버튼을 누르면 예약 폼이 뜬다. 항목: 매일/요일 선택/간격, 시각(HH:MM, 여러 개 가능), 알림 켜기(기본 켜짐), 결과 파일 저장(기본 꺼짐), 변수 값(민감 변수는 저장 안 함 안내와 함께 **예약 불가** 표시). 저장하면 매일 작업 목록에 나타난다.
3. 매일 작업 줄을 펼치면 그 작업의 **실행 이력**(전체, 상태 필터, 20건씩 더 보기)이 보인다. 실패 건은 실패 단계, 오류 메시지, 실패 스크린샷(썸네일 또는 파일명 + 폴더 열기)이 보인다. **지금 실행** 과 **다시 실행** 버튼이 있다.
4. 예약이 실패해 크롬 알림이 뜨면, 알림을 클릭했을 때 사이드패널 페이지가 매일 작업 탭으로 열린다(사이드패널 API 가 제스처 문제로 거절하면 `sidepanel.html?tab=daily` 를 일반 탭으로 연다).
5. 흐름 탭 카드에 예약 배지(다음 실행 시각)와 마지막 성공 시각이 보이고, 필터(사이트별, 발행됨, 예약 있음, 최근 실패)가 동작한다.
6. 흐름 탭에 **가져오기** 버튼이 있다. JSON 파일을 고르면 미리보기(이름·단계 수·id 충돌 여부)를 보여주고, 충돌이면 새 id 로 복사할지 덮어쓸지 고른다.
7. Claude Code 의 `chrome_shortcut action=schedules` 와 `history` 에 흐름 예약도 함께 나온다(이름 `flow:<flowId>`, 응답에 `target` 필드).
8. 모든 문구 한국어, 대시류 문자 없음, 왼쪽 세로 액센트 띠 없음.

## 설계 결정

### 예약 대상 확장 (통일의 실체)

- `ScheduleRecord` 에 `target?: { kind: 'shortcut'; name: string } | { kind: 'flow'; flowId: string; args?: Record<string, string> }` 추가. 없으면 `{ kind: 'shortcut', name }` 로 읽는다(마이그레이션 = 읽기 시 보정, 저장 형식 revision 올림).
- 흐름 예약의 `name` 은 `flow:<flowId>` 로 고정한다. 알람 이름·이력 키·잠금이 전부 name 을 쓰므로 그대로 재사용된다. 표시용 이름은 흐름 이름을 조회해서 보여준다(레코드에 `label` 스냅샷도 저장해 흐름이 지워져도 이력이 읽히게 한다).
- `executeScheduledRun` 은 target.kind 로 분기한다. `flow` 면 **공용 실행 함수**를 부른다.
- 공용 실행 함수: `tools/record-replay.ts` 의 `FlowRunTool.execute` 본체를 `entrypoints/background/record-replay/run-published-flow.ts` 같은 파일의 `runPublishedFlow(input, ctx)` 로 뽑는다. 도구 핸들러와 예약 엔진이 같은 함수를 쓴다. 입력: flowId, args, startUrl?, tabId?, lane, timeoutMs, signal, `_mcpSessionId`(예약은 `schedule` 세션 키). 출력: `summarizeRunResult` 와 같은 요약 + `tabSource`. 예약 실행은 항상 백그라운드 새 탭(`created_from_start_url` 경로)이고 끝나면 탭을 닫는다(단축 예약과 같은 정리 규칙, `releaseRunTabLeases`).
- 예약 실행 실패 시 스크린샷은 단축과 같은 방식(다운로드 폴더 파일)으로 남기고 `RunRecord.screenshot` 에 파일명. 흐름 엔진이 entries 에 base64 로 남긴 것은 그대로 두되 예약 이력에는 넣지 않는다(3MiB 상한 보호).
- `classifyRunOutcome` 의 `login_required` 는 흐름에도 적용: 흐름 실행 결과의 `failedStep` 이 흐름 변수 `loginCheck`(마법사에서 지정 가능, 선택) 와 같으면 `login_required`. 1단계 마법사에 "이 단계가 실패하면 로그인 만료로 본다" 체크를 단계 목록 옆에 하나 둔다(선택 사항, 없어도 동작).
- MCP 도구 `chrome_shortcut` 의 `schedules`/`history` 응답에 `target` 을 싣는다(응답 필드 추가는 스키마 변경이 아니다). `schedule` 액션으로 흐름을 예약하는 파라미터(`flowId`)는 **이번에 넣지 않는다**(스키마 변경 = bridge 재발행). 흐름 예약은 사이드패널에서만 만든다. 다음 릴리스 메모에 남긴다.
- record-replay 자체 예약(`RR_SCHEDULE_FLOW` 등)은 2단계에서 건드리지 않았다. **삭제됨(2026-09-06, 3단계)**.

### 사이드패널 ↔ 백그라운드 메시지 (계약, D 가 구현하고 E 가 소비)

`common/message-types.ts` 에 추가, `entrypoints/background/record-replay/index.ts`(또는 새 `daily-messages` 핸들러 파일)에서 처리, 사이드패널 래퍼는 `entrypoints/sidepanel/utils/daily-messages.ts`.

| 메시지                   | 요청                                                                                              | 응답                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `DAILY_LIST_SCHEDULES`   | 없음                                                                                              | `{ success, schedules: ScheduleView[] }`                                                                         |
| `DAILY_PUT_SCHEDULE`     | `{ target, schedule: {every}｜{daily, days?}, params?, notify?, report?, loginCheck?, enabled? }` | `{ success, schedule: ScheduleView }`                                                                            |
| `DAILY_REMOVE_SCHEDULE`  | `{ name }`                                                                                        | `{ success }`                                                                                                    |
| `DAILY_SET_ENABLED`      | `{ name, enabled }`                                                                               | `{ success, schedule }` (끄기 = 알람 해제 + 레코드 유지, `enabled:false`)                                        |
| `DAILY_RUN_NOW`          | `{ name }`                                                                                        | `{ success, runId }` (예약 큐를 타서 직렬화 규칙 유지, trigger `manual`)                                         |
| `DAILY_HISTORY`          | `{ name?, status?: string[], since?, limit?, cursor? }`                                           | `{ success, runs: RunRecord[], nextCursor? }`                                                                    |
| `DAILY_GET_RUN`          | `{ runId }`                                                                                       | `{ success, run: RunRecord }` (results 포함)                                                                     |
| `DAILY_OPEN_SCREENSHOT`  | `{ filename }`                                                                                    | `{ success }` (`chrome.downloads.search` 로 찾아 `chrome.downloads.show`, 없으면 `sidepanel_screenshot_missing`) |
| `RR_IMPORT_FLOW_PREVIEW` | `{ json }`                                                                                        | `{ success, flows: [{ id, name, stepCount, conflict: boolean }] }`                                               |
| `RR_IMPORT_FLOW` (기존)  | `{ json, mode: 'copy'｜'overwrite' }`                                                             | `{ success, imported: [{ oldId, newId, name }] }` (`copy` 는 새 id·이름 뒤 " (복사)")                            |
| `DAILY_CHANGED` (방송)   | 예약·이력이 바뀔 때                                                                               | 사이드패널이 목록·이력 새로고침                                                                                  |

`ScheduleView` = `ScheduleRecord` + `{ label, kind, enabled, nextAt, lastStatus, lastRunAt, summaryText }`(summaryText 는 백그라운드가 아니라 사이드패널 유틸에서 만든다. 시간대는 `timeZone`/`offsetMinutes` 그대로).
`enabled` 는 새 필드. 기존 레코드는 `true` 로 읽는다.

## 작업 분할

### D. 백그라운드: 예약 대상 확장 + 공용 흐름 실행 + 메시지 (opus)

- 위 "설계 결정" 전부. 범위: `utils/shortcut-schedule.ts`, `utils/shortcut-history.ts`, `entrypoints/background/schedule-runner.ts`, `tools/record-replay.ts`(본체 추출), 새 `run-published-flow.ts`, `tools/shortcut.ts`(응답 `target`), `common/message-types.ts`, `record-replay/index.ts` 또는 새 핸들러 파일, `flow-store.ts`(가져오기 preview/copy), 알림 클릭(`chrome.notifications.onClicked` 에 `mcp-shortcut-fail::` 접두사 처리), 사이드패널 래퍼 `entrypoints/sidepanel/utils/daily-messages.ts`(타입 포함, E 가 그대로 import).
- 건드리지 않는 것: `entrypoints/sidepanel/**` 의 래퍼 외 파일, `_locales`, `packages/shared` 파라미터(설명 문구만), record-replay 자체 예약 코드, 1단계 녹화 로직.
- 테스트: (1) target 없는 옛 레코드 읽기 보정 (2) flow 예약 실행이 `runPublishedFlow` 를 부르고 탭을 닫음 (3) 실패 시 스크린샷 파일명 기록 (4) `login_required` 판정 (5) enabled false 면 알람 없음·실행 안 함 (6) RUN_NOW 가 큐를 탐 (7) 가져오기 preview 충돌 판정과 copy 모드 새 id (8) 도구 `schedules` 응답 `target`. 기존 테스트 통과.
- 합격: 확장 build·test 0, 브리지 test 0(shared 스키마 파라미터 불변 확인 `git diff packages/shared`).

### E. 사이드패널: 매일 작업 탭 + 예약 폼 + 이력 + 카드 + 가져오기 (opus, D 와 병렬. 계약은 위 표)

- `App.vue` 탭 3개: 흐름(workflows), **매일 작업(daily)**, 요소 마킹. `SidepanelNavigator` 에 항목 추가. 딥링크 `?tab=daily` 지원.
- 새 컴포넌트: `components/daily/DailyView.vue`(목록·펼침 이력), `DailyScheduleForm.vue`(예약 폼, 흐름 카드와 매일 작업 탭 양쪽에서 씀), `DailyRunHistory.vue`(필터·더 보기·실패 상세·스크린샷·다시 실행), `components/workflows/ImportFlowDialog.vue`.
- 예약 요약 문구·다음 실행 표시는 `utils/daily-format.ts` 순수 함수(테스트).
- 흐름 카드: 예약 배지(다음 실행), 마지막 성공 시각, 예약 버튼. 필터 바(사이트, 발행됨, 예약 있음, 최근 실패).
- 실행 전 변수 폼(1단계 `RunVariablesDialog`)에 기본값·필수 표시 추가. 예약 폼에서는 민감 변수가 있으면 예약 저장 버튼 비활성 + 이유 문구.
- 흐름 탭 실행 이력(접이식)은 유지하되 5건 제한을 없애고 실패 건 base64 스크린샷 썸네일 표시.
- 단축키 `open_workflow_sidepanel`(`wxt.config.ts` 주석 처리분) 활성, 기본 Ctrl+Shift+Y 처럼 충돌 없는 조합. 팝업 메뉴에 "매일 작업" 진입 버튼.
- D 가 끝나기 전에는 `daily-messages.ts` 를 계약대로 **직접 만들어 쓰고**, D 가 만든 파일이 들어오면 그것으로 교체(충돌 시 D 것이 정본). 시작 전에 D 진행 여부를 `git status` 로 확인.
- 문구 전부 `getMessage('sidepanel_daily_*')` ko·en. 대시류·세로 띠 금지.
- 테스트: daily-format(요약 문구, 다음 실행 상대 시각, 요일 표기), 예약 폼 검증(시각 형식, 민감 변수 차단), 가져오기 미리보기 표시, 카드 필터 로직.
- 합격: build·test 0, ko·en 키 집합 동일, 대시류 0.

### F. 통합 시연 (메인)

배포본 교체·리로드 후: 1단계에서 발행한 흐름에 예약(매일 1분 뒤 시각) → 매일 작업 탭에 표시 → 지금 실행 → 이력에 성공 → `chrome_shortcut action=schedules` 에 `flow:` 항목 → 예약 해제. 가져오기: 내보낸 JSON 을 copy 모드로 → 카드 2개. 알림 클릭은 실패 예약을 하나 만들어 확인.

## 공통 규칙

1단계와 같다: 한국어 문구 대시류 금지, 세로 액센트 띠 금지, 결과 보고에 명령·종료 코드·파일·테스트·미해결, 하지 않은 검사를 했다고 쓰지 않기, 새 파일 UTF-8(BOM 없음), 브랜치 `feat/sidepanel-stage2` 에서 커밋하지 않기.

## D 구현 메모 (2026-09-05 구현자 기록)

Codex 설계 검토를 반영해 위 "설계 결정"·"메시지 계약"에서 바꾼 점과 그 이유다. **아래가 현행 계약이다.**

### 1. 표시 이름과 내부 식별자를 나눴다 (검토 1)

설계는 흐름 예약의 `name` 을 `flow:<flowId>` 로 두려 했다. 그러면 그 문자열을 이름으로 가진 단축과
저장소 키·알람·이력·잠금이 통째로 겹친다. 겹침을 막으려고 단축 이름 공간에 `flow:` 접두를 예약하는
길도 있었지만, 단축 이름은 사용자 자유이고 "왜 이 이름은 안 되는가" 를 설명할 수 없다. 그래서
**양쪽 모두** 접두를 붙였다.

- `scheduleId` = `shortcut:<encodeURIComponent(name)>` 또는 `flow:<encodeURIComponent(flowId)>`.
  인코딩 뒤에는 `:` 이 남지 않으므로 두 공간이 만나지 않는다. 단축 `save` 에 거부 로직은 넣지 않았다.
- 저장소 키(`mcpShortcutSchedules`), 알람 이름(`mcp-shortcut::<scheduleId>`), 잠금, 이력 키,
  runId, 작업 탭 레인이 전부 `scheduleId` 다.
- `ScheduleRecord.name` 은 표시 이름 스냅샷이다(단축 이름 / 예약 당시의 흐름 이름). 흐름을 지워도
  이력이 읽힌다.
- 레인은 `laneForScheduleId()` 를 지난다. `sessionKeyOf` 가 레인을 64자에서 자르므로, 긴 흐름 id 로
  만든 식별자는 `sched-<FNV-1a 해시>` 로 접는다. 접지 않으면 잘린 두 예약이 같은 작업 탭 버킷을 쓴다.
- **옛 레코드 보정은 읽기 때만** 한다(`normalizeScheduleRecord`). `scheduleId`·`target`·`enabled` 를
  메모리에서 채우고 키를 옮기지만 `revision`·`generation` 은 건드리지 않는다. 읽을 때마다 올리면
  돌고 있던 정상 실행이 `superseded` 로 끝난다. 저장은 그 레코드를 고치는 다른 쓰기가 있을 때 따라온다.

### 2. 메시지 계약 변경

| 바뀐 것                                                                             | 전                                                                         | 후                                                                             |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `DAILY_REMOVE_SCHEDULE`·`DAILY_SET_ENABLED`·`DAILY_RUN_NOW`·`DAILY_HISTORY` 의 대상 | `name`                                                                     | `scheduleId`                                                                   |
| `ScheduleView`                                                                      | `ScheduleRecord + { label, kind, enabled, nextAt, lastStatus, lastRunAt }` | 여기에 `scheduleId`·`target` 추가                                              |
| `DAILY_HISTORY` 응답                                                                | `runs: RunRecord[]`                                                        | `runs`(= `results` 본문을 뺀 레코드 + `resultsChars`), `matched`, `nextCursor` |
| `RR_IMPORT_FLOW` 응답                                                               | `imported: number`                                                         | `imported: [{oldId,newId,name}]`, `count`, `mode`                              |

`DAILY_HISTORY` 의 `cursor` 는 다음 페이지의 시작 위치(0-based)를 담은 문자열이다. 이력은 최신순
고정이라 "20건씩 더 보기" 에는 이 편이 시각·id 합성 커서보다 단순하다.

### 3. 예약 생성 시 사전 검증 (검토 3)

`DAILY_PUT_SCHEDULE` 은 흐름이 **밤에 혼자 돌 수 있는지**를 먼저 본다. 실패는 `errorCode` 로 온다.

- `flow_not_published` 발행되지 않았다(발행 스냅샷이 곧 실행 대상이다).
- `flow_start_url_required` 시작 URL 이 없다. 예약 실행은 스스로 작업 탭을 열어야 한다.
- `flow_has_sensitive_vars` 민감 변수가 있다. 예약 레코드는 평문 저장소에 남으므로 값을 담지 않는다.
- 단축 대상은 `chrome_shortcut action=schedule` 과 같은 규칙을 본다(첫 step, loginCheck, 비밀 파라미터).

### 4. enabled 는 알람만으로 끄지 않는다 (검토 2)

`DAILY_SET_ENABLED` 는 `revision`·`generation` 을 함께 올린다(`patchScheduleMeaning`). 알람만 지우면
이미 큐에 들어간 항목이 그대로 돌고, 끝나면서 옛 레코드 기준으로 알람을 다시 건다. 더해서
`acquireRunSlot` 이 실행 직전에 최신 레코드의 `enabled` 를 다시 본다. 다만 사용자가 방금 누른
"지금 실행"(`trigger: manual`)은 꺼져 있어도 돈다. `reconcile` 도 꺼진 예약은 따라잡지 않고 남은
알람만 걷는다.

### 5. 공용 실행 함수 (검토 4)

`entrypoints/background/record-replay/run-published-flow.ts` 의 `runPublishedFlow(input, invoke)`.
도구(`record_replay_flow_run`)와 예약 러너가 같은 함수를 부른다. 보존한 것:

- 발행 스냅샷만 실행, 탭 결정 순서(주입 tabId → 시작 URL 로 `chrome_navigate(background:true)` →
  `no_work_tab`), `effectiveBackgroundMode: true`, `withTabLease` 범위, 모든 경로의
  `releaseRunTabLeases`, 첫 navigate 중복 제거.
- 크롬 도구 호출은 **주입**받는다. 이 모듈이 `tools/index` 를 직접 import 하면 예약 러너까지 도구
  레지스트리의 순환 import 에 끌려들어간다. 배선은 `tools/index.ts` 가 한다
  (`setScheduledFlowRunner(runPublishedFlow)`).
- 마감은 호출자의 `timeoutMs` 와 외부 `signal` 을 함께 본다(예약 러너의 120초 예산이 외부 신호다).
- 세션 키는 기존 예약 코드와 같은 `scheduled::<lane>` 이다. `schedule` 로 바꾸지 않았다.
- 시작 URL 로 만든 탭은 run 소유가 아니라 **작업 탭**이다. MCP 호출에서는 그대로 남고, 예약 실행만
  `cleanupScheduledSessionTabs` 로 닫는다.

### 6. 이력은 한 곳에만 쌓는다 (검토 5)

예약 흐름 실행은 `RunOptions.persistRun: false` 로 흐름 엔진의 IndexedDB 이력(`rr_storage.runs`)을
끄고, 통합 이력(`mcpShortcutHistory`)에만 남긴다. 실패 스크린샷도 base64 가 아니라 다운로드 폴더
**파일 이름**으로 남는다(3MiB 상한 보호). 수동 실행(MCP·사이드패널 Run)은 예전 그대로다.

흐름 실행 결과 판정은 `classifyFlowRunOutcome()` 이다. 실패 로그의 `stepId` 가 예약의 `loginCheck` 와
같으면 `login_required`, `paused` 면 `stopped`, 그 밖은 `failed`(코드는 오류 문구의 접두). `FailedStep`
에 흐름용 `stepId?` 를 더했다.

`chrome_shortcut action=history` 는 이름으로 물으면 **두 키**를 함께 본다: 수동 실행이 쌓이는 단축
이름 키와 예약 실행이 쌓이는 `shortcut:<enc(name)>` 키. 사용자에게는 같은 단축의 실행 기록이다.
응답 항목마다 `target` 과 `label` 이 붙는다.

### 7. 알림 클릭 (검토 7)

`chrome.sidePanel.open()` 은 사용자 제스처 안에서만 열린다. 창 id 를 얻으려고
`chrome.windows.getLastFocused()` 를 먼저 기다리면 그 사이에 제스처가 사라진다. 그래서 창 id 는
`chrome.windows.onFocusChanged` 로 미리 받아 두고, `onClicked` 핸들러는 **await 없이 곧바로**
`sidePanel.open({ windowId })` 를 시도한다. 거절되면 `sidepanel.html?tab=daily` 를 탭으로 연다.
`setOptions` 는 연 뒤에 한다. 두 경로 모두 try/catch 다.

### 8. 확인만 하고 건드리지 않은 것

- **삭제됨(2026-09-06, 3단계)** record-replay 자체 예약(`RR_SCHEDULE_FLOW`, flow-store 의 `FlowSchedule`, `rescheduleAlarms`)의 알람
  이름은 `rr_schedule_<id>` 이고 예약 엔진의 알람은 `mcp-shortcut::<scheduleId>` 다. 접두가 달라
  겹치지 않는다(`scheduleNameFromAlarm` 은 자기 접두만 인정하고, `rescheduleAlarms` 는
  `rr_schedule_` 로 시작하는 알람만 지운다). 2단계에서는 코드를 그대로 두었고, 3단계에서 지웠다.
- `packages/shared` 파라미터 불변. `git diff packages/shared` 가 비어 있다. 흐름 예약을 **만드는** 길은
  사이드패널뿐이고, 도구 표면에는 `schedules`·`history` **응답 필드**만 늘었다.

### 9. 알려진 한계 (검토 6)

- **정확히 한 번 실행 보장은 없다.** `running` 이력 기록이 `safeWrite` 로 감싸여 있어 저장이 실패해도
  실행은 진행된다. 저장소 claim 이 이중 실행 방지의 마지막 방어선인데 그 기록이 없으면 다른 워커가
  같은 due 를 다시 집을 수 있다. 이번 범위에서는 고치지 않았다.
- **MV3 워커가 재시작하면 큐가 사라진다.** 메모리 큐이므로 대기 중이던 항목은 없어지고, 돌고 있던
  실행은 다음 워커 평가의 `markRunningAsInterrupted` 가 `interrupted` 로 종결한다(하트비트가 멈춘
  잠금도 그때 회수된다). 흐름 예약도 단축 예약과 **같은** 방식으로 정리된다.
- 흐름 실행에는 단계마다 부르는 훅이 없어 `user_took_over_tab` 판정을 실행이 끝난 뒤 한 번만 한다.
  단축 예약은 예전처럼 매 step 앞에서 본다.

### 10. Codex 코드 리뷰 반영 (2026-09-05, D 2차)

1. **옛 이력이 화면에서 사라지지 않는다 (MEDIUM).** 이 버전 이전의 단축 예약 이력은 단축 이름을 키로
   쌓여 있다. `DAILY_HISTORY` 는 `historyKeysFor()` 로 `scheduleId` 와 이름 키를 **함께 읽고** 같은
   `runId` 는 한 번만 싣는다. 저장소를 옮기지 않은 이유: 이력은 밤새 쌓이는 큰 값이라 옮기는 쓰기가
   끊기면 반쪽짜리가 남고, 수동 `chrome_shortcut run` 은 앞으로도 이름 키에 쌓이므로 병합은 어차피
   필요하다. `chrome_shortcut action=history` 도 같은 규칙이다.
2. **탭 정리를 보호된 finally 로 (MEDIUM).** `cleanupOnce(sessionKey)` 손잡이를 만들어 정상 경로의
   기존 자리(스크린샷 뒤)와 `finally` 양쪽에서 부른다. 결과 가공·보고서 저장·인계 판정이 던져도 예약이
   연 백그라운드 탭과 스폰 스코프가 남지 않는다. 단축 경로와 흐름 경로 모두 같은 구조다.
3. **입력 검증 (MEDIUM).** `sender.id === chrome.runtime.id` 확인을 먼저 하고, 메시지마다
   `readScheduleId`(우리 형식만) · `readBoolean`(강제 변환 금지) · `readStatuses`(상태 allowlist) ·
   `readLimit`(1~100) · `readCursor`(숫자 문자열) · `readScreenshotName`(`mcp-screenshots/` 접두,
   `..` 금지, png·jpg 만) 을 지난다. `DAILY_PUT_SCHEDULE` 의 `enabled`·`notify`·`report` 도 불리언이
   아니면 `flag_invalid` 로 거절한다.
4. **복사 id 충돌 (LOW).** `uniqueFlowId` 는 순번 후보가 다 차면 무작위 꼬리를 붙이되 **겹치지 않는
   것을 확인하고** 돌려준다. 예전에는 `Date.now()` 값을 검사 없이 돌려줘 같은 밀리초의 두 복사본이
   서로를 덮어썼다.
5. **테스트 (LOW).** `tests/record-replay/run-published-flow.test.ts` 를 추가해 흐름 엔진만 대역으로
   바꾸고 공용 실행 함수 자체를 확인한다(탭 출처, 외부 신호·마감이 둘 다 끊는지, 리스 해제,
   `persistRun` 전달, `no_work_tab`). 알람 이름 전환·양쪽 이력 키 병합·입력 검증·정리 회귀는
   `tests/utils/daily-schedule.test.ts` 에, 같은 id 중복과 후보 고갈은 `flow-import-modes` 에 넣었다.
6. **사이드패널 래퍼.** `runScheduleNow` 가 `{ runId, queued }` 를 그대로 돌려준다. `queued:false` 는
   실패가 아니라 "이미 그 예약이 큐에 있다" 이므로 화면이 그렇게 말할 수 있어야 한다.
