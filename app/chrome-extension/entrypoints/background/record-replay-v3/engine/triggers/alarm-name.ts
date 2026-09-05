/**
 * chrome.alarms 이름 <-> triggerId 변환.
 *
 * cron / interval / once 세 트리거 처리기가 각자 접두사만 다른 동일한 파서를 들고 있었다.
 * 접두사를 인자로 받는 함수 하나로 합친다. 동작은 이전 세 구현과 같다.
 */
import type { TriggerId } from '../../domain/ids';

/** alarm 이름에서 triggerId 를 뽑는다. 접두사가 다르면 null. */
export function parseTriggerIdFromAlarmName(prefix: string, name: string): TriggerId | null {
  if (!name.startsWith(prefix)) return null;
  const id = name.slice(prefix.length);
  return id ? (id as TriggerId) : null;
}
