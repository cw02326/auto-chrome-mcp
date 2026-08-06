# Site Permissions Auto-Allow — Design

**Date**: 2026-05-29
**Status**: Design (ready for implementation)
**Scope**: `app/chrome-extension/`

---

## 1. 문제

Chrome MCP 의 현재 도구 셋(`handle_dialog`, `click_element`, `fill_or_select`, ...)은 JS 의 `alert/confirm/prompt` 는 자동 처리할 수 있지만, **사이트 단위 권한 prompt** (popup 차단, 알림 허용, 카메라/마이크/위치 정보, 클립보드 접근 등)는 처리하지 못한다. AI 가 사이트를 자동 조작할 때마다 사용자가 직접 Chrome 의 native 권한 prompt 를 눌러야 하므로 자동화가 끊긴다.

## 2. 목표

- AI 가 방문/조작하는 사이트의 Chrome native 권한 prompt 가 뜨지 않도록 한다 — **사이트 origin 단위로 동적으로 `allow` 세팅** (자세한 이유는 §15 참조).
- 비민감 권한(popup, notifications, clipboard, automaticDownloads)은 install 시점에 **`<all_urls>` 일괄 allow** — 별도 confirm 불요.
- 민감 권한(camera, microphone, geolocation)은 개인정보 직접 노출 + OS 권한 의존성 때문에 `<all_urls>` 일괄 allow 부적합. AI 가 사용 시점에 **현재 active tab 의 origin 단위로 `allow` 세팅** + popup 토글이 OFF 면 사용자 confirm 거침.

> **v1.0.31 → v1.0.32 변경**: location/geolocation 을 비민감 5종에서 빼고 민감 3종 (consent gate) 으로 이동. 사유 — 위치 정보는 카메라/마이크와 동급의 개인정보 + OS 권한 의존이라 install 시 자동 일괄 allow 부적합. 신뢰 모델 일관성 강화 (AI 가 방문한 사이트만 누적 자동 허용).

## 3. 비-목표 (Out of scope)

- 사이트별/origin 별 권한 토글 — 무조건 글로벌 (`<all_urls>`).
- contentSettings 재설정/관리 UI — install 시 1회 세팅 후 코드가 다시 안 건드린다.
- AI 호출 audit log — 추후 별도 작업.
- `chrome.permissions.request()` 자동 승인 — Chrome 정책상 user gesture 필수, 불가능.
- Web Bluetooth / Web USB / WebMIDI 디바이스 chooser — user gesture 필수, 불가능.

## 4. 아키텍처

### 4.1 권한 처리 두 갈래

| 권한 종류                                                    | 처리 방식                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `popups`, `notifications`, `clipboard`, `automaticDownloads` | 확장 install 시 contentSettings 를 `<all_urls>` 패턴에 대해 `allow` 로 세팅. 이후 코드가 안 건드림. AI 가 별도로 호출할 함수 없음 — 모든 사이트에서 native prompt 안 뜸.                                                                                                                         |
| `camera`, `microphone`, `geolocation`                        | 개인정보 직접 노출 + OS 권한 의존성 때문에 `<all_urls>` 일괄 allow 부적합 (camera/mic 는 Chrome 정책상 거부 — §15 참조). popup UI 의 토글 + `chrome_request_user_consent` 함수가 통과되면 **현재 active tab 의 origin 단위** 로 `chrome.contentSettings.X.set({primaryPattern: origin/*})` 호출. |

### 4.2 핵심 원칙

- **비민감 4종은 install 시점에 한 번 `<all_urls>` allow** 세팅하고 끝.
- **민감 3종 (camera/microphone/geolocation) 은 consent 통과 시점에 origin 단위 sticky allow** — 한 번 set 하면 그 사이트는 영구 통과, 다른 사이트는 무관.
- **Popup 토글은 사용자 의사 게이트** — AI 가 confirm 받을지 + origin 단위 allow set 까지 자동으로 진행할지 여부.
- 모든 사이트에서 결과적으로 native prompt 안 뜨는 UX 는 동일. 다만 내부 구현은 "install 일괄" + "사용 시 origin 별 누적" 의 hybrid.

## 5. MCP 함수 명세

신규 함수 **1개만** 추가:

### `chrome_request_user_consent`

```ts
{
  action: 'camera' | 'microphone' | 'geolocation',
  reason: string  // 사용자에게 보여줄 설명. AI 가 작성.
}
```

**동작**:

1. `chrome.storage.local` 의 `sitePermissionToggles[action]` 읽음.
2. **ON** → 현재 active tab 의 origin 에 대해 contentSettings 동적 allow set (§5.1) → `{ approved: true, source: 'toggle' }` 반환. 창 안 뜸.
3. **OFF** → consent 창(`chrome.windows.create`) 띄움 → 사용자 응답 대기:
   - "이번만 허용" → origin 단위 allow set → `{ approved: true, source: 'one-shot', remembered: false }`
   - "이번만 허용" + "다음부터 묻지 않기" 체크 → origin 단위 allow set + 토글 자동 ON → `{ approved: true, source: 'one-shot', remembered: true }`
   - "거부" → set 없음 → `{ approved: false, source: 'one-shot' }`
   - 창 X 닫기 → set 없음 → `{ approved: false, source: 'dismissed' }`
   - 60초 timeout → set 없음 → `{ approved: false, source: 'timeout' }`

비민감 권한(popups/notifications/clipboard/automaticDownloads/location)을 위한 MCP 함수는 **없음** — install 시 자동 처리되므로 AI 가 호출할 일이 없다.

### 5.1 Origin 단위 동적 allow set

approved 가 결정되면 (`source: 'toggle'` 또는 `'one-shot' + approved:true`) 다음을 실행:

```ts
const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
const origin = tab?.url ? new URL(tab.url).origin : null;
if (origin && /^https?:/.test(origin)) {
  const pattern = `${origin}/*`;
  await chrome.contentSettings[action].set({ primaryPattern: pattern, setting: 'allow' });
}
```

- 이미 set 돼있어도 idempotent (덮어쓰기).
- origin 이 chrome://, file://, about:// 등이면 skip (sensible no-op).
- set 실패해도 approved 결과는 그대로 반환 — 사이트 JS 가 호출 시 native prompt 뜨게 될 뿐.

### 5.2 Sticky 특성

`chrome.contentSettings.X.set` 은 Chrome `regular` scope 에 영구 저장됨. 브라우저 재시작 / 확장 update 후에도 유지. 즉 한 사이트당 평생 1회 set 만 일어남 — 두 번째 방문부터는 토글 ON 인 경우 set 호출이 idempotent no-op.

### 기존 함수와의 관계

- `handle_dialog` — JS `alert/confirm/prompt` 처리. **그대로 유지**, 영역 다름.
- 기타 모든 기존 도구 — 영향 없음.

## 6. UI 변경

### 6.1 Popup 하단에 "권한 설정" 섹션 추가

`app/chrome-extension/entrypoints/popup/App.vue`

```
┌─ 권한 설정 ─────────────────────────────┐
│  AI 가 아래 권한을 사용하려 할 때,        │
│  토글이 OFF 면 사용자에게 확인합니다.     │
│                                          │
│  📷 카메라          [OFF ●─────]         │
│  🎤 마이크          [OFF ●─────]         │
│  📍 위치 정보       [OFF ●─────]         │
└──────────────────────────────────────────┘
```

- **Default: 모두 ON** (install 시점에 초기화). 사용자가 의식적으로 OFF 하기 전까지는 묻지 않음.
- `chrome.storage.local` 와 양방향 바인딩.
- 한 번 사용자가 OFF 로 내린 토글은 확장 update 시에도 덮어쓰지 않음 — install (`reason: 'install'`) 이벤트일 때만 초기값 세팅, update/chrome_update 일 때는 storage 값 유지.

### 6.2 Consent 창 (신규 entrypoint)

`chrome.windows.create({ type: 'popup', width: 420, height: 260, url: 'consent.html?id=...&action=...&reason=...' })`

```
┌─ Chrome MCP — AI 권한 요청 ────────────┐
│                                         │
│  📷 카메라 사용 요청                     │
│                                         │
│  이유: {reason}                          │
│  사이트: {현재 active tab 의 origin}     │
│                                         │
│  ┌─────────┐  ┌──────────────────┐      │
│  │  거부    │  │  이번만 허용      │      │
│  └─────────┘  └──────────────────┘      │
│                                         │
│  □ 다음부터 묻지 않기 (토글 ON)          │
└─────────────────────────────────────────┘
```

## 7. 메시지 흐름

```
AI tool 호출 (chrome_request_user_consent)
  └→ background: tool handler
        ├→ storage.local 에서 토글 읽기
        │   └ ON  → §5.1 origin 단위 allow set → {approved:true, source:'toggle'} 반환
        │   └ OFF → 아래 진행
        ├→ requestId 생성 (UUID)
        ├→ pendingConsents.set(requestId, {resolve, reject, timer})
        ├→ chrome.windows.create('consent.html?id=...')
        ├→ chrome.windows.onRemoved 리스너 등록 (창 닫기 감지)
        ├→ setTimeout(60s) → deny + cleanup
        └→ Promise await

consent.html (Vue)
  ├→ query string 파싱 → 텍스트 렌더
  ├→ [거부] → runtime.sendMessage({type:'CONSENT_RESPONSE', id, approved:false})
  ├→ [이번만 허용] → ({approved:true, remember:checkbox.checked})
  │     └ remember=true → storage 의 해당 토글도 ON 으로 업데이트
  └→ 응답 후 window.close()

background: 메시지 수신
  ├→ pendingConsents.get(id) → resolve → timer clear, 리스너 해제
  ├→ approved=true 면 §5.1 origin 단위 allow set
  └→ AI 에게 결과 반환
```

## 8. 파일 변경 목록

```
app/chrome-extension/
├ wxt.config.ts                                      [수정] permissions 에 'contentSettings' 추가
├ entrypoints/
│  ├ background/
│  │  ├ index.ts                                     [수정] runtime.onInstalled 에서 contentSettings 전부 allow
│  │  └ tools/browser/
│  │     ├ index.ts                                  [수정] userConsentTool export 추가
│  │     └ user-consent.ts                           [신규] chrome_request_user_consent 핸들러 + pendingConsents Map
│  ├ consent/                                        [신규 entrypoint]
│  │  ├ index.html
│  │  ├ main.ts
│  │  └ App.vue
│  └ popup/
│     └ App.vue                                      [수정] 하단 "권한 설정" 섹션 + 토글 3개
└ shared/
   └ consent-storage.ts                              [신규] storage 키/타입, get/set 헬퍼
```

## 9. Storage 스키마

`chrome.storage.local`:

```ts
{
  sitePermissionToggles: {
    camera: true,
    microphone: true,
    geolocation: true,
  }
}
```

- 타입은 `shared/consent-storage.ts` 에 정의.
- 초기값은 install 이벤트에서만 세팅 (update 시 기존 값 보존).

## 10. Manifest 변경

`app/chrome-extension/wxt.config.ts` 의 `manifest.permissions` 에 `'contentSettings'` 추가. 그 외 변경 없음 (`<all_urls>` host_permissions 는 이미 있음).

## 11. 구현 순서

각 단계는 독립적으로 동작 검증 가능하도록 분리.

1. **Manifest** — `contentSettings` permission 추가.
2. **Install hook** — `runtime.onInstalled` 에서 (a) **비민감 4종** (popups/notifications/clipboard/automaticDownloads) 만 `<all_urls>` allow (매 이벤트마다 실행). camera/microphone/geolocation 은 민감 3종이라 일괄 allow 안 함 — camera/mic 는 Chrome 정책상 거부 (§15 참조), location 은 v1.0.32+ 부터 사용자 신뢰 모델 일관성 위해 origin 단위로만 처리. (b) `reason === 'install'` 일 때만 `sitePermissionToggles` 3종 (camera/microphone/geolocation) 전부 `true` 로 storage 초기화. console 로 결과 로깅.
3. **Storage 헬퍼** — `shared/consent-storage.ts`.
4. **Popup UI** — "권한 설정" 섹션 + 토글 3개. storage 양방향 바인딩.
5. **Consent 창** — `entrypoints/consent/` 페이지. query 파싱 + 버튼 + 체크박스 + 메시지 전송.
6. **MCP 함수** — `tools/browser/user-consent.ts`. pendingConsents Map + windows.create + 60s timeout + onRemoved + **§5.1 origin 단위 allow set** (approved 시 호출, https?:// 만 처리, set 실패는 silent).
7. **Tool 등록** — `tools/browser/index.ts` export 추가 + MCP server 라우팅 확인.
8. **수동 테스트** — AI 가 함수 호출, 토글 OFF/ON, 창 닫기, timeout 시나리오.
9. **문서 업데이트** — `README.md` + `README_zh.md` 에 "사이트 권한 자동 허용" 섹션 추가 (§13.1 참조).

## 12. 엣지 케이스

| 케이스                                                    | 처리                                                                                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 사용자가 consent 창 X 로 닫음                             | `windows.onRemoved` 리스너로 감지 → `{approved:false, source:'dismissed'}`                                                                                          |
| AI 가 동시에 여러 consent 요청                            | requestId 로 구분, 각자 별도 창 (큐잉 안 함)                                                                                                                        |
| 60초 안에 응답 없음                                       | timer 만료 → `{approved:false, source:'timeout'}` + 창 자동 close                                                                                                   |
| contentSettings 세팅 실패 (사용자 / 정책 충돌)            | console.error 로 로깅, 확장은 정상 동작 (해당 권한만 native prompt 뜨게 됨)                                                                                         |
| 사용자가 popup 토글을 ON → OFF 로 되돌림                  | 다음 AI 호출부터 다시 confirm. 이전 호출엔 영향 없음 (이미 set 된 origin 들은 sticky 라 그대로).                                                                    |
| Incognito 모드                                            | contentSettings 는 incognito 별도. 이번 design 은 일반 세션만 다룸.                                                                                                 |
| Active tab origin 이 chrome:// / file:// / data: / about: | §5.1 의 정규식 가드에서 skip. approved 결과는 정상 반환. 사이트 JS 가 호출 시 native prompt 뜸 (정상 — chrome:// 내부 페이지는 어차피 카메라 호출할 일 없음).       |
| 사용자가 chrome://settings 에서 카메라를 명시적 block     | extension scope 의 set('allow') 가 user-scope override 못 함. approved 는 반환되지만 사이트 JS 호출 시 native prompt (deny) 발생. README 에 "직접 차단 안 함" 안내. |
| 같은 origin 에 대해 두 번째 consent 요청                  | 이미 sticky 라 set 호출은 idempotent no-op. consent 창은 토글 OFF 인 경우에만 다시 뜸 (토글 ON 위임이면 즉시 통과).                                                 |

## 13. 문서 / README 변경 (필수)

### 13.1 README 변경 사항

`README.md` (한국어, root) 와 `README_zh.md` (중국어) 양쪽에 **"⚠️ 사이트 권한 자동 허용"** 섹션을 새로 추가한다. 위치: "## 2. Claude Code 에 등록" 다음, "## 왜 fork?" 이전. install flow 직후라 사용자가 절대 놓치지 않는 위치.

**섹션 내용 (한국어 초안)**:

```markdown
## ⚠️ 사이트 권한 자동 허용 — 알아두세요

scalemaker 는 AI 자동화가 끊기지 않도록 Chrome 사이트 권한 prompt 를
**자동으로 처리**합니다 (두 갈래):

| 권한                | 처리 시점                        | 효과                                                                        |
| ------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| Popups              | 확장 install 시 모든 사이트 일괄 | 모든 사이트의 `window.open()` 차단 안 됨                                    |
| Notifications       | 확장 install 시 모든 사이트 일괄 | 알림 권한 prompt 안 뜸 — 자동 허용                                          |
| Clipboard           | 확장 install 시 모든 사이트 일괄 | 사이트의 클립보드 읽기 prompt 안 뜸                                         |
| Automatic downloads | 확장 install 시 모든 사이트 일괄 | 여러 파일 자동 다운로드 prompt 안 뜸                                        |
| Geolocation         | 확장 install 시 모든 사이트 일괄 | 위치 정보 prompt 안 뜸                                                      |
| **Camera**          | **AI 가 방문한 사이트만 누적**   | Chrome 정책상 일괄 불가. AI 가 사용한 사이트만 그 origin 영구 허용 (sticky) |
| **Microphone**      | **AI 가 방문한 사이트만 누적**   | 동일                                                                        |

추가로 **카메라 / 마이크 / 위치 정보** 3종은 AI 가 실제로 사용하려 할 때
사용자 confirm 을 받을 수 있도록 popup UI 의 토글로 제어 가능합니다.

- **Default 상태**: 토글 3종 전부 **ON** → AI 가 묻지 않고 즉시 사용.
- **OFF 로 내리면**: AI 가 해당 기능을 호출할 때마다 작은 confirm 창이 떠서
  사용자에게 허용 여부를 묻습니다.
- 끄려면: 확장 아이콘 클릭 → popup 하단의 "권한 설정" 섹션에서 토글 OFF.

> **보안 경고** — 이 설정은 scalemaker 의 dev / 자동화 용도에 최적화된 것입니다.
> 같은 Chrome 프로필로 일반 웹서핑도 한다면, 임의 사이트가 카메라 / 마이크 /
> 위치 정보에 접근할 수 있습니다. 별도 Chrome 프로필 사용을 강하게 권장합니다.
```

**중국어 README** 도 같은 내용으로 번역 추가. 톤은 기존 README 의 다른 섹션과 맞춤.

### 13.2 변경하지 않는 문서

- `app/chrome-extension/README.md` — 개발자용 README. 자동 권한 세팅은 사용자 경험 영역이라 root README 만으로 충분.
- `docs/ARCHITECTURE.md` — 권한 처리 흐름이 아키텍처 수준이 아니라 별도 기능이라 미반영. 단 §11 step 9 끝낸 후 필요 판단되면 추가.
- `FORK.md` / `UPSTREAM_DIFF.md` — fork 신규 기능 목록에 한 줄 추가 ("Site permissions auto-allow + consent gate UI") 정도면 충분.

## 14. 보안 고려

- **비민감 5종 (popups/notifications/clipboard/automaticDownloads/location)** 은 install 시점부터 모든 사이트에 `allow`. 일반 사용자가 같은 Chrome 프로필로 웹서핑하면 임의 사이트의 알림 / 위치 정보 prompt 가 안 뜸 → 위험. README §13.1 의 별도 Chrome 프로필 권장으로 완화.
- **민감 2종 (camera/microphone)** 은 **AI 가 실제로 방문/조작한 사이트에 한해서만** 누적 allow. 사용자가 직접 방문하는 사이트에는 영향 0 (해당 origin set 안 되어 있음). scalemaker 의 신뢰 모델 = "AI 에게 위임한 사이트 = 사용자가 의식적으로 신뢰한 사이트" 와 일치.
- Popup 토글은 **민감 2종에 대해서만** 의미가 있음 (consent 거치고 origin set 까지의 게이트). 비민감 5종은 토글과 무관하게 항상 자동 허용.
- chrome://settings 에서 사용자가 명시적으로 카메라/마이크를 차단해뒀다면 extension 의 set('allow') 가 못 override. 그 경우 native prompt 가 deny 됨 — 의도된 사용자 결정이라 그대로 존중.

## 15. 결정 로그

| 결정                                                | 대안                                               | 채택 이유                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP 함수 1개 (`chrome_request_user_consent`)        | set/get/reset 3개 함수로 contentSettings 매번 조작 | install 시 한 번 세팅하고 끝내면 함수 surface 가 단순해지고 AI 가 매번 권한 만질 일 없음                                                                                                                                                                                                              |
| 무조건 글로벌 (`<all_urls>`)                        | origin 별 토글 / scope 인자                        | "모든 사이트에서 작동해야" 라는 사용자 요구                                                                                                                                                                                                                                                           |
| 토글 default ON                                     | default OFF (보안 우선)                            | scalemaker 는 AI 자동화가 주 목적 — 매 호출마다 confirm 뜨면 흐름 끊김. 사용자 요청에 따라 "기본 위임" 으로 결정. 사용자는 popup 에서 언제든 OFF 가능. update 시엔 사용자가 내린 OFF 를 덮어쓰지 않음.                                                                                                |
| Consent 창 = 별도 popup window                      | Chrome notification / 새 탭 / side panel           | 작은 modal-like 창이 가장 명확하고 user gesture 없이 띄울 수 있음                                                                                                                                                                                                                                     |
| "다음부터 묻지 않기" 체크박스                       | 항상 묻기                                          | 매번 confirm 귀찮은 사용자가 그 자리에서 ON 가능. Default 체크 해제로 명시적 opt-in 유지                                                                                                                                                                                                              |
| 60초 timeout                                        | 무한 대기                                          | AI tool call 이 무한히 매달리지 않도록                                                                                                                                                                                                                                                                |
| 민감 2종 → origin 단위 동적 set                     | install 시 `<all_urls>` 일괄 allow                 | 검증 결과 Chrome 이 `'allow' is not supported as the default setting of camera/microphone` 에러로 거부. specific origin pattern (예: `https://example.com/*`) 으로는 통과됨. sticky 저장이라 사이트당 평생 1회 set 으로 충분 → "AI 가 방문한 사이트만 누적 허용" 모델. 검증 로그는 conversation 참조. |
| 민감 2종 → CDP `Browser.grantPermissions` 도입 보류 | contentSettings.set 만 사용                        | CDP 는 더 강력하나 (a) "Chrome 이 자동화 소프트웨어에 의해 제어되고 있습니다" 노란 바, (b) debugger attach/detach 관리 비용, (c) origin contentSettings.set 만으로 99% 케이스 커버 — 굳이 추가 안 함. 추후 contentSettings 가 막히는 케이스 발견되면 fallback 으로 도입 검토.                         |
