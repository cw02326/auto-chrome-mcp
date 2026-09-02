/**
 * Force-focus policy gate (auto-chrome-mcp fork).
 *
 * v1.9.0 부터 구현체는 `utils/activation-guard.ts` 하나로 합쳤다. 탭 활성화와 윈도우 포커스가
 * 서로 다른 파일에 흩어져 있어 경로마다 조건이 어긋난 것이 무간섭 모드가 새던 원인이었다.
 * 이 파일은 기존 import 경로를 깨지 않기 위한 재수출 shim 이다.
 *
 * 범위 — OS 윈도우 포커스만 게이트:
 *   - chrome.windows.update({focused: true})    → 정책 OFF 면 호출 자체 skip
 *   - chrome.windows.create({focused: true})    → 정책 OFF 면 focused: false 로 생성
 * 범위 밖 (탭 활성화):
 *   - chrome.tabs.update({active: true}) / chrome.tabs.create({active: true})
 *     → 강제 포커스 토글과 **무관**하게 activation-guard 의 규칙을 따른다.
 *       (백그라운드 작업 모드 ON 이면 전용 MCP 작업 창 안에서만 활성화)
 *
 * 기본값 false — 새로 설치하는 사용자는 강제 포커스 없음. 사용자가 명시적으로 ON 으로 토글해야 동작.
 */

export {
  isForceFocusEnabled,
  setForceFocusEnabled,
  focusWindow as focusWindowIfAllowed,
  FORCE_FOCUS_STORAGE_KEY_NAME as FORCE_FOCUS_STORAGE_KEY,
} from './activation-guard';
