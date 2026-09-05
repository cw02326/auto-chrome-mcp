# 데일리 업무 자동화 설계: 예약 실행·이력·알림 (2026-09-05)

## 배경

`chrome_batch` 와 `chrome_shortcut` 은 2026-09-04 설계로 값 전달·조건·반복·`params` 를 얻었다(`docs/plans/2026-09-04-batch-flow-design.md`). 그러나 셋이 아직 없다. (1) Claude 가 없을 때 스스로 실행되는 수단, (2) 실행 이력과 결과 보관·조회, (3) 실패 알림. 사용자 목표는 반복되는 웹 업무를 매일 Claude 없이 돌리고, 아침에 Claude 가 결과만 확인·정리하는 것이다.

이 문서는 확장 쪽만 다룬다. 읽은 계약: `shortcut.ts`(저장 형식 `StoredShortcut`, `params`, `runSteps` 호출 경로), `batch-runner.ts`(`RunStepsOptions`, `MAX_TOTAL_RUNS=100`, `MAX_BATCH_MS=100_000`, `MAX_RETURN_ITEM_CHARS=8_000`, `MAX_RETURN_TOTAL_CHARS=24_000`), `work-tab-gate.ts`(작업 탭 없으면 `no_work_tab` 거절, `tabId` 양의 정수만 인정), `work-tab-manager.ts`(`sessionKeyOf` 가 `_mcpSessionId::lane` 을 만든다, `MAX_SESSIONS=32`), `artifact-path.ts`(`mcp-screenshots/YYYY-MM-DD/<kind>_<name>_<HHmmss>.<ext>`), `wxt.config.ts`(`alarms`·`notifications` 권한이 이미 있다).

## 목표

`chrome_shortcut` 하나로 "저장 → 예약 → 밤새 실행 → 아침에 `history` 로 읽기" 가 끝난다. 예약 실행은 MCP 세션 없이 확장 안에서만 돌고, 사용자 탭 보호 규칙을 한 줄도 우회하지 않는다.

## 목표가 아닌 것

브리지(node) 쪽 스케줄러, 크롬 밖 실행, cron 문법, 비밀번호 저장, 예약 병렬 실행. 이유는 마지막 절.

## 1. 예약 실행(schedule)

### 어디에 붙이나

| 후보                                | 장점                                                                  | 단점                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| A. `chrome_shortcut` 에 action 추가 | 저장·검증·실행 경로를 그대로 쓴다. 스키마 하나, 모델이 배울 도구 하나 | action enum 이 8개로 는다                                                                               |
| B. 새 도구 `chrome_schedule`        | 관심사 분리                                                           | shortcut 저장 형식·params 검증을 다시 import 하거나 복제. 도구 수가 늘면 모든 호출의 스키마 토큰이 는다 |
| C. 브리지가 cron 으로 MCP 호출      | 크롬 밖에서도 예약                                                    | 브리지 프로세스가 항상 떠 있어야 하고, MCP 세션 없이 호출하는 경로를 새로 뚫어야 한다                   |

**확정: A.** 왜: 예약은 "저장된 shortcut 을 언제 돌리나" 라는 속성이지 별개 개체가 아니다. 저장 시 검증(`stale_target_forbidden`, `undeclared_param`)을 그대로 상속받는다.

### 스케줄 표현

```json
{
  "action": "schedule",
  "name": "daily-dashboard",
  "schedule": { "daily": ["08:00"], "days": ["mon", "tue", "wed", "thu", "fri"] },
  "params": { "site": "https://dash.example.com" },
  "notify": true,
  "report": false
}
```

- `every: "15m" | "1h" | "6h" | "24h"` 또는 `daily: ["HH:mm", ...]`(로컬 시간, 최대 4개, 서로 5분 이상 간격) 중 정확히 하나. 둘 다 있거나 둘 다 없으면 `schedule_invalid`. `days` 는 `daily` 에만 붙는 선택 항목(`mon`~`sun`, 비면 매일).
- cron 은 쓰지 않는다. 왜: 사용자가 읽지 못하는 표기이고, 분 단위 표현력은 데일리 업무에 필요 없으며, 파서가 곧 오류 표면이다. 위 두 형태로 "N시간마다" 와 "매일 몇 시" 를 다 덮는다.
- shortcut 하나에 스케줄 하나. 다시 `schedule` 하면 덮어쓴다(`replaced: true`). 왜: "이 shortcut 의 예약" 을 한 번에 지우고 바꿀 수 있어야 아침에 정리가 쉽다.
- `params` 는 실행마다 주입할 값이다. 선언과 대조해 `unknown_param`·`missing_param` 을 예약 시점에 잡는다(실행 시점에 실패하면 밤에 아무도 못 본다).
- `action: "unschedule"` 은 알람과 예약 레코드를 지운다. shortcut `delete` 도 예약을 함께 지운다. `action: "schedules"` 는 이름·표현·`nextAt`·마지막 실행 status·`failStreak` 만 싣는다.

### 알람 구조

- 알람 하나당 이름 `shortcut-schedule::<name>`, **항상 일회성**(`when: nextAt`). 실행이 끝나면 다음 시각을 계산해 다시 건다. `every` 도 `periodInMinutes` 를 쓰지 않는다. 왜: 코드 경로가 하나가 되고, 크롬이 꺼져 있던 동안 쌓인 주기 알람이 몰아서 울리는 일이 없다.
- 예약 레코드는 `chrome.storage.local` 키 `mcpShortcutSchedules` 에 `{ [name]: { schedule, params?, notify, report, loginCheck?, nextAt, revision, createdAt, lastRunId?, lastStatus?, failStreak } }`. `revision` 은 `schedule`·`unschedule`·`save`·`delete` 마다 1 증가한다. 실행 중이던 run 은 종료 시 자기 `revision` 과 레코드의 것이 다르면 재무장·`lastStatus`·`failStreak` 갱신을 하지 않고 이력에 `superseded: true` 만 남긴다. 왜: 실행 도중 사용자가 shortcut 을 고치거나 예약을 지웠는데 옛 실행이 끝나며 알람을 다시 걸면 "지운 예약이 돈다". **2026-09-05 Codex 리뷰 3 반영**: 실제 판정 값은 `revision` 이 아니라 저장소 전역 단조 `generation` 이다(`mcpShortcutScheduleGeneration`). `revision` 은 예약마다 1 부터 다시 세므로 실행 중 `unschedule` -> `schedule` 을 하면 옛 값과 같아진다(ABA). `generation` 은 `putSchedule`·`bumpScheduleRevision` 에서만 오르고 `nextAt`·`lastStatus` 같은 살림살이 갱신에서는 그대로이며, 모든 reconcile·outcome patch 는 이 값으로 CAS 하고 알람은 patch 에 성공한 레코드에서만 건다.
- **MV3 복구**: `chrome.alarms.onAlarm` 리스너는 service worker 파일 최상위에서 동기로 등록한다(늦게 등록한 리스너는 워커를 깨우지 못한다). 그리고 **워커가 평가될 때마다**(알람·메시지·어떤 이벤트로 깨든) `reconcile()` 을 한 번 돌린다: `running` 이력을 `interrupted` 로, `scheduled::<name>` 고아 탭 정리(2절), 레코드는 있는데 `chrome.alarms.get` 에 없는 알람 재생성. `onStartup` 만으로는 부족하다. 왜: 확장 업데이트·크래시·유휴 종료 뒤 재평가는 `onStartup` 을 거치지 않는다.
- **따라잡기**: `reconcile()` 에서 `nextAt <= now` 인 예약은 **한 번만** 큐에 넣고 `nextAt` 을 현재 시각 기준 격자로 다시 계산한다. 놓친 8회를 몰아서 돌리지 않는다. 왜: 게시판 확인을 8번 연달아 해 봐야 같은 결과이고, 100초짜리 실행 8개가 아침 크롬 시작을 13분 점유한다.
- **결정적 runId 로 이중 실행 방지**: `runId = "<name>:<dueAtISO>"`. 알람 리스너는 어떤 `await` 도 하기 전에 메모리의 `pending/running` set 에 `runId` 를 넣고, 그 다음 `mcpShortcutHistory` 에 같은 `runId` 가 이미 있으면 포기한다(storage claim). 왜: 알람과 `reconcile()` 따라잡기가 같은 due 를 동시에 집을 수 있다. 시각을 이름에 넣으면 두 경로가 같은 키로 충돌해 하나만 남는다.
- **시간 규칙**: `every` 의 다음 due 는 **이전 due 시각** 기준 격자다(종료 시각이 아니다). 실행이 밀려도 다음 due 는 원래 격자 위에 있다. `daily` 는 로컬 `Date` 로 계산하고 `days` 는 로컬 요일이다. DST spring-forward 로 없는 시각은 그 다음 존재하는 분에 1회, fall-back 으로 두 번 오는 시각은 1회만. `Intl.DateTimeFormat().resolvedOptions().timeZone` 과 현재 오프셋을 레코드에 두고 `reconcile()` 에서 달라졌으면 모든 `nextAt` 을 재계산한다. `daily` 시각 간 5분 간격 검사는 같은 날 안에서만 한다(23:58 과 00:01 은 서로 다른 날이라 허용).
- keepalive: 실행 시작부터 스크린샷·report·탭 정리가 끝날 때까지 20초마다 `chrome.runtime.getPlatformInfo()` 를 호출한다(**리뷰 5**: 하트비트·keepalive 는 정리까지 감싸는 바깥 `finally` 에서만 끈다. 러너를 감싼 안쪽에서 끄면 마무리 작업이 잠금 없이 돈다)(Chrome 110+ 는 확장 API 호출이 유휴 타이머를 되돌린다). 도구 호출 자체도 확장 API 를 쓰지만 `chrome_wait_for` 처럼 오래 기다리는 step 이 있어 보조 수단이 필요하다.

## 2. 실행 컨텍스트

- 합성 세션: `_mcpSessionId: "scheduled"`, `lane: <shortcutName>`. `sessionKeyOf` 가 그대로 `scheduled::<name>` 을 만들므로 work-tab-manager 를 고치지 않는다. lane 은 64자에서 잘리는데 shortcut 이름 상한도 64라 충돌이 없다.
- **강제 background 는 인자 덮어쓰기가 아니라 실행 컨텍스트의 모드다.** 예약 실행은 `runSteps` 에 `forceBackground: true` 를 주고, 러너는 invoker 에 넘기는 `ToolCallParam` 에 내부 전용 `effectiveBackgroundMode: true` 를 싣는다. 게이트(`work-tab-gate`)·URL 대상 해석(`url-target`)·navigate 의 탭 재사용·활성화 가드·`chrome_close_tabs` 는 전역 토글 `isBackgroundModeEnabled()` 보다 이 값을 **우선** 읽는다. 값이 없으면 지금처럼 전역 토글을 본다. 왜: 인자 `background:true` 만 덮으면 전역 OFF 상태의 게이트가 작업 탭 주입 자체를 건너뛰어 도구가 활성 탭으로 fallback 한다. 모드를 컨텍스트에 실어야 모든 판정 지점이 같은 답을 낸다. 전역 모드가 OFF 여도 예약 실행은 항상 background 규칙이며, 인자 없는 `chrome_close_tabs` 는 예약 실행에서 `scheduled::<name>` 소유 탭만 닫는다. 이 키는 스키마에 없고 step args 에 적혀 있어도 버린다.
- **첫 step 규칙**: `steps[0]` 은 repeat 묶음이 아니고, `when` 이 없고, `tool` 이 `chrome_navigate` 이며, `url` 이 문자열로 있고(템플릿 허용), `refresh`·`back`·`forward` 류 동작이 아니어야 한다. 예약 시점에 검사해 `schedule_first_step_invalid` 로 거절한다. 왜: 작업 탭이 없는 세션은 게이트가 `no_work_tab` 으로 거절하므로 navigate 로 작업 탭을 만드는 것 외에 시작할 길이 없고, 조건부·새로고침 navigate 는 탭을 만들지 않는다. navigate 는 background 모드에서 현재 창에 비활성 탭을 만든다.
- **스폰 탭·팝업 창(리뷰 1)**: 실행이 도는 동안 그 세션 소유 탭이 연 새 탭(`target=_blank`·`window.open`)은 즉시 같은 버킷 소유가 되고, 사용자가 보던 탭·창을 그 자리에서 되돌린다(`tabs.update({active:true})`·`windows.update({focused:true})`). 판정은 전역 토글이 아니라 실행 스코프가 한다 - 토글이 꺼져 있어도 예약 실행에는 적용된다. 팝업 창의 탭은 언제나 그 창의 활성 탭이므로 인계 판정에서 빼고, 실행이 끝나면 탭과 창을 함께 닫는다.
- **탭 인계**: 각 step 을 부르기 전에, 그리고 **마지막 step 이 끝난 뒤 산출물·정리보다 먼저 한 번 더**(리뷰 6) `scheduled::<name>` 소유 탭이 어떤 창에서든 활성 탭이 됐는지 확인한다. 뒤늦게 발견하면 스크린샷·report 를 만들지 않는다. 됐으면 실행을 `user_took_over_tab` 으로 중단하고, 그 탭은 **닫지 않고** 소유·작업 탭 기록만 해제한다. 왜: 사용자가 눌러 본 탭을 도구가 계속 조작하거나 닫는 것이 곧 사용자 탭 침해다.
- 실행이 끝나면(성공·실패·중단 모두) `scheduled::<name>` 버킷의 소유 탭을 닫고 `clearWorkTab` 한다. 왜: 예약 20개가 각자 탭을 남기면 아침에 탭 20개가 쌓이고, `MAX_SESSIONS=32` 버킷도 압박한다. `failed` 류면 닫기 전에 스크린샷 1장을 먼저 저장한다(4절). `reconcile()` 은 `scheduled::` 접두 버킷의 고아 탭을 같은 규칙으로 정리한다(활성 탭이면 닫지 않고 소유만 해제).
- **직렬화와 잠금**: 확장 안에 실행 큐 하나. 알람이 울렸는데 다른 예약이 돌고 있으면 큐 뒤에 붙이고, 같은 이름이 이미 큐에 있으면 넣지 않는다. 잠금은 `chrome.storage.session` 의 `scheduledRunLock: { runId, name, owner, nonce, heartbeatAt }`. 획득은 **쓰고 나서 다시 읽어**(fenced) 자기 `nonce` 가 남아 있을 때만 성공으로 보고, 잠금·이력 claim·`running` 기록을 같은 임계 구역에서 끝낸다(리뷰 4 - 읽고 나서 쓰는 방식은 두 워커가 같은 순간에 읽으면 둘 다 잡았다). `reconcile` 은 하트비트가 살아 있는 lease 의 `runId` 를 `interrupted` 로 바꾸지 않고 그 버킷의 탭도 건드리지 않는다. `owner` 는 워커 인스턴스마다 새로 만든 토큰이고 실행 중 10초마다 `heartbeatAt` 을 갱신한다. `heartbeatAt` 이 30초 이상 갱신되지 않은 잠금은 죽은 것으로 보고 회수한다. 왜: 워커가 죽으면 메모리 큐도 죽는다. 고정 130초 판정은 정상 실행 중 워커가 교체된 경우와 진짜 죽은 경우를 구분하지 못한다. 실행 end-to-end 상한은 120초(batch 100초 + 스크린샷·report·정리 20초). 두 예약을 병렬로 돌리지 않는 이유는 lane 을 나눠도 창 하나에 탭이 동시에 열리는 모습이 사용자에게 보이고, 탭 그룹·다운로드 폴더 경합이 생기기 때문이다.
- 포커스 불변 규칙: 예약 실행은 `chrome.windows.update`·`chrome.tabs.update({active:true})` 를 부르는 어떤 도구도 실행하지 않는다. 이미 `DISALLOWED_STEP_TOOLS` 가 `chrome_switch_tab` 을 막고, 게이트가 `background:true` 를 강제하므로 새 규칙이 아니라 기존 규칙의 확인이다. 검수 항목 6에서 활성 탭 id 를 전후 비교한다.

## 3. secret 과 로그인

- 예약 레코드의 `params` 에는 `secret` 로 선언된 이름을 넣을 수 없다(`secret_param_in_schedule`). `required: true` 인 `secret` 이 있는 shortcut 은 예약 자체가 거절된다(`secret_required_unschedulable`). 왜: 값을 저장하지 않으면 실행이 반드시 실패하고, 값을 저장하면 `chrome.storage.local` 에 평문 비밀번호가 남는다. 확장 저장소는 같은 프로필의 다른 확장·디버거·디스크 복사에 노출되고, 확장이 암호화한들 키가 같은 곳에 있어 눈속임이다. 그래서 비밀번호 저장 선택지를 만들지 않는다.
- 기본 안내 (a): 로그인이 필요한 데일리 작업은 **크롬 프로필의 기존 로그인 세션(쿠키)** 을 그대로 쓴다. 사용자가 그 사이트에 한 번 로그인해 두면 예약 실행의 작업 탭도 같은 프로필이라 쿠키를 공유한다. shortcut 은 로그인 화면 없이 대시보드 URL 로 바로 navigate 한다.
- 만료 감지 (b): navigate 직후 `chrome_find` 로 로그인 폼(또는 `chrome_extract` 로 로그아웃 버튼 부재)을 판정하고 `stopIf` 로 끝낸다. 예약 러너는 `stoppedBy.reason === "stopIf"` 이고 그 step 의 `as` 이름이 예약 옵션 `loginCheck` 와 같으면 status 를 `login_required` 로 기록하고 알림을 보낸다. `loginCheck` 는 **top-level step 의 `as`** 만 가리킬 수 있다(repeat 안쪽 이름은 `schedule_invalid`). 왜: 일반 `stopIf` 는 정상 조기 종료(새 글 없음)이므로 실패로 취급하면 안 되고, 어느 stop 이 "로그인 필요" 인지는 shortcut 작성자만 안다. 묶음 안쪽 이름은 회차마다 비워져 판정이 흔들린다. 예시 (c) 참조.
- **수동 실행의 secret 과 이력**: `run` 에 `secret` 값이 들어온 실행은 이력을 남기되, history writer 가 저장 직전에 레코드의 모든 문자열(`error`, `results`, `stoppedBy`, 경고)에서 secret 원문과 JSON-escaped 형태를 `***` 로 가린다(`shortcut.ts` 의 `maskSecrets` 재사용). 그 실행은 실패 스크린샷을 만들지 않는다. 왜: 비밀번호가 입력창에 보이는 화면이 파일로 남는다. `report` 파일은 예약 실행 전용이고 예약에는 secret 이 없음이 3절 규칙으로 보장되지만, 저장 직전에 한 번 더 secret 흔적 검사를 한다.

## 4. 실행 이력(history)

- 저장소 키 `mcpShortcutHistory`: `{ [name]: RunRecord[] }`, 최신이 앞. `run`(manual) 과 예약(scheduled) 모두 기록한다.

```json
{
  "runId": "20260905-080012-daily-dashboard",
  "name": "daily-dashboard",
  "trigger": "scheduled",
  "status": "failed",
  "startedAt": 1788570012000,
  "endedAt": 1788570047000,
  "durationMs": 35000,
  "failedStep": { "index": 2, "tool": "chrome_extract" },
  "errorCode": "unresolved_reference",
  "error": "unresolved_reference: kpi.values.total",
  "stoppedBy": null,
  "results": { "kpi": { "values": { "total": null } } },
  "resultsTruncated": [],
  "screenshot": "mcp-screenshots/2026-09-05/failure_daily-dashboard_080047.png",
  "report": null,
  "warnings": [],
  "revision": 3,
  "superseded": false
}
```

- `status` enum(확정): `success | failed | stopped | timeout | interrupted | skipped_queue | login_required | user_took_over_tab`. `stopped` 는 `stopIf` 정상 종료, `timeout` 은 100초 벽시계 상한, `interrupted` 는 실행 중 워커·크롬이 죽은 것, `skipped_queue` 는 큐 대기 10분 초과로 실행하지 않은 것. `total_runs_exceeded` 는 `timeout` 이 아니라 `failed` + `errorCode: "total_runs_exceeded"` 다. 왜: 시간 초과와 호출 수 초과는 원인이 달라 아침에 다르게 고쳐야 한다.
- `failedStep` 은 `{ index, tool }` 로 0-based 인덱스와 도구 이름을 함께 싣는다. 왜: 번호만으로는 shortcut 을 다시 열어 세어야 한다.
- 실행 시작 시 `status: "running"` 레코드를 먼저 쓰고 종료 시 같은 `runId` 로 덮어쓴다. `reconcile()` 은 `running` 레코드를 `interrupted` 로 바꾸고, 바뀐 레코드마다 한 번씩 `lastStatus`·`failStreak` 갱신과 첫 실패 알림까지 한다(리뷰 7 - `generation` 이 다르면 이력에 `superseded` 만 남긴다). 왜: 종료 처리를 못 한 실행이 영원히 "실행 중" 으로 남으면 아침에 판단할 수 없다.
- **history writer 는 하나의 직렬 큐**다. 모든 기록·갱신·정리는 이 큐를 통해 read-modify-write 한다. 왜: manual `run` 과 예약 종료가 같은 키를 동시에 쓰면 한쪽이 사라진다.
- `errorCode` 는 오류 문구의 첫 `:` 앞 토큰(`unresolved_reference`, `no_work_tab` 처럼 이미 코드형 접두를 쓴다). 접두가 없으면 `tool_error`.
- 스크린샷·report 저장 실패는 본 실행의 `status` 를 바꾸지 않고 `warnings` 에 `screenshot_failed`·`report_failed` 로만 남긴다.
- `results` 는 shortcut 의 `return` 으로 지정한 이름만, 항목당 8,000자·총 24,000자(batch 와 같은 상한, 넘는 항목은 통째로 빼고 `resultsTruncated`). 왜: history 가 batch 응답보다 커질 이유가 없고, 잘린 JSON 은 쓸모가 없다.
- 실패 시 스크린샷 1장: 러너가 `failed`·`timeout` 을 확정한 직후 작업 탭에 `chrome_screenshot` 을 한 번 부르고 `artifactFilename("failure", name, "png")` 경로로 저장한다. 스크린샷 자체가 실패해도 기록은 남긴다(`screenshot: null`).
- 보관 상한: shortcut 당 100건, 전체 1,000건, 전체 크기 3MiB. 크기는 `mcpShortcutHistory` 키 전체 payload 를 `JSON.stringify` 한 뒤 `TextEncoder` 로 잰 byte 다. 셋 중 하나를 넘으면 전체에서 가장 오래된 레코드부터 지운다. `chrome.storage.local.set` 이 **용량 초과로 보이는** 오류를 내면 가장 오래된 1건씩만 지우고 최대 3회 다시 시도한다(방금 쓰는 레코드는 지우지 않는다). 용량과 무관한 오류는 그대로 던진다 - 리뷰 9 전에는 어떤 오류에도 보관량을 절반으로 잘랐다. 왜: `chrome.storage.local` 은 `unlimitedStorage` 없이 10MB 이고 shortcut·userscript 저장소와 공유한다.
- 보고서 파일(옵션 `report: true`, 기본 꺼짐, 예약 실행 전용): 레코드 전체 JSON 을 `saveArtifactToDownloads({ kind: "report", name, ext: "json" })` 으로 저장해 `Downloads/mcp-screenshots/YYYY-MM-DD/report_<name>_<HHmmss>.json` 이 된다. 이 파일의 `results` 는 history 의 24,000자 대신 256KiB(UTF-8) 까지 담고, 넘는 항목은 통째로 빼 `resultsTruncated` 에 적는다. 그러려면 러너가 `runSteps` 에 `reportLimitBytes` 를 주어 **이력용과 별개의 `return` 페이로드**(`reportReturned`)를 받아야 한다(리뷰 10 - 이력용 24,000자 결과를 재료로 쓰면 상한을 아무리 키워도 그보다 큰 값은 파일에도 없다). 기본을 끈 이유: 크롬 다운로드 알림이 화면에 보인다. 24,000자로 모자랄 때만 켠다.
- 조회: `{ "action": "history", "name"?, "limit"?: 20, "since"?: "2026-09-04T22:00:00", "status"?, "runId"? }`. `name` 이 없으면 모든 shortcut 을 합쳐 최신순. `limit` 기본 20, 상한 100. `runId` 를 주면 그 레코드 하나를 `results` 포함 전체로 돌려준다. `runId` 없는 목록 응답은 **요약만**: `runId, name, trigger, status, startedAt, durationMs, failedStep, errorCode, resultsChars, screenshot, report`. `results` 본문은 싣지 않는다. 왜: 밤새 30건 × 24,000자는 Claude 컨텍스트를 밀어낸다. 요약으로 고른 뒤 `runId` 로 하나씩 연다.

## 5. 알림

- 실패(`failed`·`timeout`·`interrupted`·`login_required`·`user_took_over_tab`) 시 `chrome.notifications.create` 로 한 줄: 제목 `Auto Chrome MCP 예약 실패`, 본문 `<name>: <errorCode 또는 status> (step <index>)`. 본문에 넣는 값은 **allowlist** `name`·`errorCode`·`failedStep.index` 뿐이고 오류 문구·결과값은 넣지 않는다. 왜: 오류 문구에는 페이지 텍스트가 섞이고, 알림은 마스킹 경로를 거치지 않는다. 성공·`stopped`·`skipped_queue` 는 조용하다. 예약 옵션 `notify` 기본 `true`.
- 폭주 방지: 예약 레코드의 `failStreak` 가 연속 실패 수. 알림은 `failStreak` 가 1 과 3 일 때만 보낸다. 4회 이상은 보내지 않고 `schedules` 응답의 `failStreak` 로만 드러낸다. 성공하면 0 으로 돌린다. 왜: 15분마다 도는 예약이 밤새 실패하면 알림 30개가 쌓인다.
- 알림 클릭 동작은 없다(권한·UI 를 늘리지 않는다). 아침에 Claude 가 `history` 로 읽는 것이 기본 경로다.

## 6. Claude 가 아침에 하는 일

1. `{ "action": "schedules" }` 로 예약 목록과 `lastStatus`·`failStreak` 를 본다.
2. `{ "action": "history", "since": "<어제 22:00>", "limit": 50 }` 로 밤새 요약을 받는다. 상태별로 묶어 사용자에게 한국어로 정리한다.
3. `failed`·`timeout`·`interrupted`·`user_took_over_tab` 건은 `{ "action": "history", "runId": "..." }` 로 하나씩 열어 `error`·`screenshot` 경로를 확인하고, `login_required` 건은 "해당 사이트에 다시 로그인해 주세요" 로 보고한다.
4. `success` 건 중 결과가 필요한 것(대시보드 수치)만 `runId` 로 열어 `results` 를 표로 만든다.
5. 반복 실패가 shortcut 결함이면 `save` 로 고치고 `schedule` 을 다시 건다.

## 7. 안전·상한

| 항목                | 값                                                                                                                                                                                    | 왜                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 예약 최대 개수      | 20                                                                                                                                                                                    | shortcut 50개 중 매일 돌 것은 소수. 알람 20개는 크롬 상한(500) 안                                        |
| 최소 간격           | 5분 (`every` 최소값 15m, `daily` 시각 간격 5분)                                                                                                                                       | 한 실행이 100초까지 걸리므로 그보다 짧으면 큐만 쌓인다                                                   |
| 한 실행 상한        | batch 100회·100초 (`MAX_TOTAL_RUNS`, `MAX_BATCH_MS` 그대로), end-to-end 120초. 상한을 넘기면 러너에 준 마감·취소 신호로 **실제로 끊고** 멈춘 것을 확인한 뒤 정리한다(리뷰 5)          | 러너를 두 벌 두지 않는다. 뒤 20초는 스크린샷·report·정리 몫                                              |
| 큐 대기 상한        | 큐에 10분 넘게 있으면 `skipped_queue` 로 기록하고 버린다                                                                                                                              | 밀린 실행이 다음 주기와 겹치지 않게                                                                      |
| 중단 기록           | 워커 평가마다 `reconcile()` 이 `running` → `interrupted`                                                                                                                              | 4절                                                                                                      |
| 사용자 인계         | 소유 탭이 활성화되면 `user_took_over_tab` 으로 중단, 탭은 닫지 않음                                                                                                                   | 2절                                                                                                      |
| `generation` 불일치 | 실행 중 예약이 바뀌면 종료 시 재무장·상태 갱신 생략, `superseded` (`revision` 은 ABA 때문에 판정에 쓰지 않는다)                                                                       | 1절                                                                                                      |
| `forceBackground`   | 예약 실행 전용. `effectiveBackgroundMode` 로 컨텍스트에 실리며 스키마에 노출하지 않는다                                                                                               | 모델이 수동 실행에서 켜고 끌 이유가 없다                                                                 |
| 게이트 우회 없음    | 예약 저장 시 레코드를 `validateOneStep(step, isV2=true)` 로 다시 검사. legacy 레코드도 literal `tabId`·`windowId`·`tabIds`·`chrome_close_tabs.url` 이 있으면 `stale_target_forbidden` | 예약은 시간이 지난 뒤 도니 저장된 탭 id 는 반드시 남의 탭이다. v1 grandfathering 은 수동 실행에만 남긴다 |
| 실행 컨텍스트 고정  | 예약 실행의 `_mcpSessionId`·`lane` 은 러너가 `scheduled`·`<name>` 으로 덮고 step 값은 버린다(batch 설계 4절 순서 그대로)                                                              | 저장된 step 이 다른 세션 키를 흉내낼 수 없다                                                             |

## 8. 스키마 변경 목록과 권한

추가만 한다. 기존 이름·타입은 그대로다(`packages/shared/src/tools.ts` 의 `chrome_shortcut` 블록).

| 위치              | 추가                                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action` enum     | `schedule`, `unschedule`, `schedules`, `history`                                                                                                    |
| 최상위            | `schedule: { every?: string, daily?: string[], days?: string[] }`                                                                                   |
| 최상위            | `notify: boolean`(schedule, 기본 true), `report: boolean`(schedule, 기본 false), `loginCheck: string`(schedule, `stopIf` 를 가진 step 의 `as` 이름) |
| 최상위            | `runId: string`, `limit: number`, `since: string`, `status: string`(history 전용)                                                                   |
| 저장소            | `mcpShortcutSchedules`(`revision` 포함), `mcpShortcutHistory` 키 신설. `mcpShortcuts` 레코드는 불변                                                 |
| `RunStepsOptions` | `forceBackground?: boolean`, `beforeStep?: () => Promise<void>`(탭 인계 검사용), `onStepSettled?: (index, result) => void`(진행 기록용, 선택)       |
| `ToolCallParam`   | 내부 전용 `effectiveBackgroundMode?: true`. 게이트·`url-target`·navigate·활성화 가드·`chrome_close_tabs` 가 전역 토글보다 우선 읽는다               |

권한: `alarms`·`notifications` 는 `wxt.config.ts` 에 이미 있다. 새로 추가할 권한은 없다. `chrome.storage.session` 은 `storage` 권한으로 충분하다.

## 9. 예시

(a) 매일 08:00 대시보드 수치 수집. 먼저 `save`, 그 다음 `schedule`.

```json
{
  "action": "save",
  "name": "daily-dashboard",
  "return": ["kpi"],
  "params": { "site": { "default": "https://dash.example.com/overview" } },
  "steps": [
    { "tool": "chrome_navigate", "args": { "url": "{{params.site}}" } },
    { "tool": "chrome_wait_for", "args": { "selector": ".kpi-card", "timeout": 10000 } },
    {
      "tool": "chrome_extract",
      "as": "kpi",
      "args": {
        "fields": {
          "visitors": ".kpi-card.visitors .value",
          "orders": ".kpi-card.orders .value",
          "revenue": ".kpi-card.revenue .value"
        }
      }
    }
  ]
}
```

```json
{
  "action": "schedule",
  "name": "daily-dashboard",
  "schedule": { "daily": ["08:00"], "days": ["mon", "tue", "wed", "thu", "fri"] },
  "report": true
}
```

아침 조회 `{ "action": "history", "name": "daily-dashboard", "limit": 1 }` 뒤 `runId` 로 열면 `results.kpi.values` 에 세 수치가 있다. `report: true` 라 같은 내용이 `report_daily-dashboard_080012.json` 으로도 남는다.

(b) 30분마다 게시판 새 글 확인. 새 글이 없으면 `stopIf` 로 끝나 `stopped` 로 기록되고 알림이 없다.

```json
{
  "action": "save",
  "name": "board-watch",
  "return": ["latest"],
  "params": { "lastSeen": { "required": true, "description": "마지막으로 본 글 번호" } },
  "steps": [
    { "tool": "chrome_navigate", "args": { "url": "https://board.example.com/list" } },
    {
      "tool": "chrome_extract",
      "as": "latest",
      "args": {
        "fields": {
          "id": { "selector": ".row:first-child .id" },
          "title": { "selector": ".row:first-child .title" }
        }
      },
      "stopIf": { "path": "latest.values.id", "op": "eq", "value": "{{params.lastSeen}}" }
    },
    { "tool": "chrome_screenshot" }
  ]
}
```

`{ "action": "schedule", "name": "board-watch", "schedule": { "every": "1h" }, "params": { "lastSeen": "10422" } }`. `every` 의 최소값이 15m 이므로 "30분마다" 는 15m 또는 1h 중 고른다(두 값 사이는 두지 않는다. 왜: 선택지를 늘리면 최소 간격 검사가 복잡해질 뿐 데일리 업무에 차이가 없다). 새 글이 있으면 `success` 로 남고 `results.latest` 에 번호·제목이 있다. Claude 는 아침에 그 번호로 `schedule` 을 다시 걸어 `lastSeen` 을 갱신한다.

(c) 로그인 세션 만료 감지·알림.

```json
{
  "action": "save",
  "name": "crm-export",
  "return": ["rows"],
  "steps": [
    { "tool": "chrome_navigate", "args": { "url": "https://crm.example.com/reports/today" } },
    {
      "tool": "chrome_find",
      "as": "loginForm",
      "args": { "query": "비밀번호 입력창", "maxResults": 1 },
      "stopIf": { "path": "loginForm.matches", "op": "notEmpty" }
    },
    {
      "tool": "chrome_extract",
      "as": "rows",
      "args": { "fields": { "names": { "selector": "table td.name", "all": true } } }
    }
  ]
}
```

`{ "action": "schedule", "name": "crm-export", "schedule": { "daily": ["07:30", "12:30"] }, "loginCheck": "loginForm" }`. 비밀번호 입력창이 보이면 `stopIf` 로 멈추고, 러너는 `loginCheck` 와 이름이 같으므로 `status: login_required` 로 기록하고 알림 `crm-export: login_required (step 1)` 을 띄운다. 사용자가 크롬에서 다시 로그인하면 다음 회차부터 정상이다.

## 10. 합격 기준·검수 체크리스트

각 줄을 단위 테스트(크롬 API mock) 또는 실제 크롬 실행으로 옮긴다. 하지 않은 검사를 했다고 쓰지 않는다.

1. `schedule` 은 `every` 와 `daily` 중 정확히 하나만 받는다. 둘 다·둘 다 없음·`every: "30m"`·`daily` 5개·5분 미만 간격·모르는 `days` 값은 각각 `schedule_invalid` 로 거절된다.
2. 예약 21개째는 `too_many_schedules`. 같은 이름 재예약은 `replaced: true` 이고 알람이 하나만 남는다(`chrome.alarms.getAll` 로 확인).
3. 예약 시 `params` 의 미선언 이름은 `unknown_param`, `required` 누락은 `missing_param`, `secret` 이름은 `secret_param_in_schedule`, `required` 인 `secret` 선언이 있는 shortcut 은 `secret_required_unschedulable`. 예약 레코드 덤프 어디에도 `secret` 값이 없다.
4. literal `tabId`·`windowId`·`tabIds`·`chrome_close_tabs.url` 을 가진 legacy 레코드는 `stale_target_forbidden` 으로 예약이 거절된다(수동 `run` 은 여전히 된다). `steps[0]` 이 repeat 묶음·`when` 있음·navigate 아님·`url` 없음·`refresh`/`back`/`forward` 중 하나면 `schedule_first_step_invalid`. `loginCheck` 가 repeat 안쪽 `as` 를 가리키면 `schedule_invalid`.
5. 알람이 울리면 `runSteps` 가 `mcpSessionId: "scheduled"`, `lane: <name>`, `forceBackground: true` 로 호출되고 invoker 가 받는 모든 `ToolCallParam` 에 `effectiveBackgroundMode: true` 가 있다. step args 에 적힌 `_mcpSessionId`·`lane`·`background:false`·`effectiveBackgroundMode` 는 버려진다(invoker mock).
6. 실제 크롬, **전역 background 토글 OFF 상태에서도**: 사용자가 다른 탭을 보고 있는 상태에서 예약이 돌아도 `chrome.tabs.query({active:true})` 의 탭 id 와 `chrome.windows.getLastFocused` 의 창 id 가 실행 전후 같고, 사용자 탭에 대한 도구 호출이 0건이다(게이트 로그). 인자 없는 `chrome_close_tabs` step 은 `scheduled::<name>` 소유 탭만 닫는다. 실행 후 소유 탭이 닫혀 있고 버킷이 비어 있다.
7. 두 알람이 같은 시각에 울리면 두 번째는 첫 번째가 끝난 뒤 시작한다(시작 시각 비교). 같은 이름이 큐에 두 번 들어가지 않는다. 큐에서 10분을 넘긴 항목은 `status: skipped_queue` 로 기록되고 실행되지 않는다.
8. 따라잡기: 크롬 시작 시 `nextAt` 이 지난 예약은 정확히 한 번 실행되고 `nextAt` 이 원래 격자의 미래 시각으로 재계산된다. 8시간 꺼져 있던 `every: "1h"` 예약도 실행 1회. 알람과 `reconcile()` 이 같은 due 를 동시에 집어도 `runId` 가 같아 이력이 1건이다.
9. history 레코드에 `runId("<name>:<dueAtISO>"), trigger, status, startedAt, endedAt, durationMs, revision` 이 있고, 실패 시 `failedStep: {index, tool}`·`errorCode`·`screenshot` 경로가 채워진다. 스크린샷 파일이 `mcp-screenshots/<오늘>/failure_<name>_HHmmss.png` 에 실제로 존재한다. 101회째 호출은 `failed` + `errorCode: "total_runs_exceeded"`, 100초 초과는 `timeout`.
10. `results` 는 `return` 이름만 담고 8,001자 항목은 빠지며 `resultsTruncated` 에 이름이 있다. shortcut 당 101번째 기록에서 가장 오래된 것이 지워지고, 전체 1,001건째와 `TextEncoder` 기준 3MiB 초과 시 전체 최고령부터 지워진다. quota 오류 주입 시 prune 후 1회 재시도로 성공한다. manual `run` 과 예약 종료가 동시에 기록해도(writer queue) 두 레코드가 모두 남는다.
11. `history` 목록 응답에 `results` 본문이 없고 `resultsChars` 만 있다. `runId` 조회는 전체 레코드를 돌려준다. `limit: 101` 은 100 으로 잘리고, `since` 이전 기록은 빠진다.
12. 실행 중 워커를 강제 종료(`chrome://serviceworker-internals` stop)하면 다음 평가의 `reconcile()` 에서 그 레코드가 `interrupted`, 고아 탭이 정리되고(활성 탭이면 소유만 해제), `chrome.alarms.clearAll` 뒤에도 레코드 수만큼 알람이 재생성되며, `heartbeatAt` 이 30초 넘은 잠금이 회수된다. 알림은 1건.
13. 알림: 연속 실패 1·2·3·4·5회에서 알림은 1회째와 3회째 두 번만 온다. 중간에 성공하면 `failStreak` 가 0 이 되고 다음 실패에 다시 온다. `notify: false` 면 오지 않는다. 성공·`stopped`·`skipped_queue` 는 알림이 없다. 알림 본문에 오류 문구·결과값 문자열이 포함되지 않는다(페이지 텍스트를 오류에 심어 확인).
14. `loginCheck` 이름의 `stopIf` 로 멈추면 `status: login_required`, 다른 이름의 `stopIf` 는 `stopped`. `report: true` 면 `report_<name>_HHmmss.json` 이 생기고 `results` 가 256KiB 까지 들어 있다. 스크린샷 저장을 실패시켜도 `status` 는 그대로이고 `warnings` 에 `screenshot_failed` 가 있다.
15. 시간: `every: "1h"` 가 08:00 due 에서 08:01:40 에 끝나도 다음 due 는 09:00. DST spring-forward 날의 `daily: ["02:30"]` 은 03:00 에 1회, fall-back 날의 `01:30`·`01:45` 는 앞선(여름시간) 쪽 1회만 - 계산은 이분 탐색이 아니라 분 단위 실제 instant 훑기다(리뷰 8). 시스템 타임존을 바꾸고 워커를 재평가하면 `nextAt` 이 새 존 기준으로 바뀐다. `daily: ["23:58","00:01"]` 은 허용된다.
16. 경쟁: 실행 중 `unschedule` 또는 `delete` 하면 실행 종료 후 알람이 재생성되지 않고 이력에 `superseded: true`, `lastStatus`·`failStreak` 는 갱신되지 않는다. 실행 중 `save` 로 덮어써도 같다.
17. 탭 인계: 실행 중 소유 탭을 사용자가 활성화하면 다음 step 전에 `user_took_over_tab` 으로 끝나고 그 탭은 열린 채 소유·작업 탭 기록만 해제된다.
18. secret 을 넘긴 manual `run` 의 history 레코드와 저장소 덤프 어디에도 secret 원문·JSON-escaped 형태가 없고, 그 실행은 실패해도 스크린샷 파일이 생기지 않는다.
19. 사용자에게 보이는 문구(스키마 description, 오류 텍스트, 알림 본문)에 U+2014, U+2013, U+3161 이 없다(파이썬 스캔).

## 11. 하지 않을 것

| 항목                                     | 이유                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 브리지 쪽 스케줄러                       | 브리지는 Claude Code 가 띄우는 stdio 프로세스라 Claude 가 없으면 없다. 항상 떠 있는 것은 크롬뿐이다 |
| 크롬 밖 실행(OS 작업 스케줄러, headless) | 로그인 쿠키·확장·게이트가 전부 사용자 프로필 안에 있다. 밖에서 돌리면 셋 다 다시 만들어야 한다      |
| cron 문법                                | 1절. 읽을 수 없고, 파서가 오류 표면이며, 데일리 업무에 분 단위 표현이 필요 없다                     |
| 비밀번호·토큰 저장                       | 3절. 저장소가 곧 평문 노출이고, 확장 안 암호화는 키가 같은 곳에 있어 눈속임이다                     |
| 예약 병렬 실행                           | 2절. 사용자 창에 탭이 동시에 열리는 것이 보이고, 탭 그룹·다운로드가 경합한다                        |
| 놓친 실행 전부 따라잡기                  | 1절. 같은 결과를 반복하며 아침 크롬을 점유한다                                                      |
| 실패 시 자동 재시도                      | 로그인 만료·사이트 변경은 재시도로 안 풀린다. 다음 주기가 곧 재시도다                               |
| 알림 클릭 UI, 팝업 예약 편집기           | 아침 경로는 Claude 의 `history` 다. UI 는 따로 설계한다                                             |

## 구현 순서

1. **이력 기록기.** `utils/shortcut-history.ts`(순수 함수: 레코드 생성, 상한·byte 정리, 요약 변환, `errorCode` 추출, secret 마스킹) + writer queue + `shortcut.ts` 의 `run` 이 `trigger: "manual"` 로 기록, `action: "history"`. 산출물: 모듈 + 단위 테스트, 스키마 `history`·`runId`·`limit`·`since`·`status`. 테스트: 9, 10, 11, 18.
2. **실행 컨텍스트 모드.** `ToolCallParam.effectiveBackgroundMode` 와 그것을 우선 읽는 게이트·`url-target`·navigate·활성화 가드·`chrome_close_tabs` 분기, `batch-runner.ts` 의 `forceBackground`·`beforeStep`. 산출물: 게이트 단위 테스트(전역 OFF + 컨텍스트 ON). 테스트: 5, 6.
3. **예약 레코드와 알람.** `utils/shortcut-schedule.ts`(순수 함수: 표현 검증, 첫 step 검증, `nextAt` 격자·DST 계산, 따라잡기 판정, `runId`) + `background/schedule-runner.ts`(최상위 `onAlarm`, `reconcile()`, 큐, heartbeat 잠금, 합성 세션, 탭 인계 검사, 탭 정리, `revision`). 산출물: 두 모듈 + 테스트, 스키마 `schedule`·`unschedule`·`schedules`. 테스트: 1~4, 7, 8, 12, 15, 16, 17.
4. **실패 처리와 마무리.** 스크린샷 1장, `chrome.notifications` allowlist 와 `failStreak`, `loginCheck` 판정, `report` 파일(`saveArtifactToDownloads` 경유, 256KiB). `docs/TOOLS.md` 예시 (a)(b)(c), `docs/CHANGELOG.md`, 대시 스캔, 실제 크롬에서 (a)(b)(c) 를 `every: "15m"` 으로 걸어 각 1회 이상 실행 로그와 아침 흐름(6절) 재현. 테스트: 13, 14, 19.
