/**
 * 테마 시스템 - 남은 테마 하나(toss-light) 강제 (2026-09-06 디자인/접근성 리뷰 대응).
 *
 * 패널은 예전에 테마를 7개 지원했다. 고르는 UI가 없었으니 6개는 죽은 코드였고,
 * 다 지웠다(ui/theme.css 도 함께). chrome.storage.local 에는 옛 설치에서 쓰던
 * 값(예: 'warm-editorial', 'dark-console')이 여전히 남아 있을 수 있으므로,
 * 무엇이 저장돼 있든 항상 'toss-light' 로 풀려야 한다 - 저장값을 지우는 게
 * 아니라 "신뢰하지 않는" 방식으로.
 *
 * 확인하려는 것.
 *   1. storage 가 비어 있으면 preloadAgentTheme 은 'toss-light' 를 돌려준다.
 *   2. storage 에 옛 테마 id 가 남아 있어도 preloadAgentTheme 은 'toss-light' 를 돌려준다.
 *   3. initTheme() 도 옛 테마 id 저장값을 무시하고 'toss-light' 로 정착한다.
 *   4. setTheme('toss-light') 는 정상적으로 저장된다.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  preloadAgentTheme,
  useAgentTheme,
} from '@/entrypoints/sidepanel/composables/useAgentTheme';

describe('useAgentTheme / preloadAgentTheme - toss-light 고정', () => {
  it('storage 가 비어 있으면 toss-light 로 풀린다', async () => {
    vi.mocked(chrome.storage.local.get).mockResolvedValueOnce({});

    const themeId = await preloadAgentTheme();

    expect(themeId).toBe('toss-light');
    expect(document.documentElement.dataset.agentTheme).toBe('toss-light');
  });

  it.each([
    'warm-editorial',
    'blueprint-architect',
    'zen-journal',
    'neo-pop',
    'dark-console',
    'swiss-grid',
  ])(
    'storage 에 옛 테마 %s 가 남아 있어도 preloadAgentTheme 은 toss-light 로 풀린다',
    async (oldThemeId) => {
      vi.mocked(chrome.storage.local.get).mockResolvedValueOnce({ agentTheme: oldThemeId });

      const themeId = await preloadAgentTheme();

      expect(themeId).toBe('toss-light');
    },
  );

  it('initTheme() 도 옛 테마 저장값을 무시하고 toss-light 로 정착한다', async () => {
    vi.mocked(chrome.storage.local.get).mockResolvedValueOnce({ agentTheme: 'dark-console' });

    const { theme, ready, initTheme } = useAgentTheme();
    await initTheme();

    expect(ready.value).toBe(true);
    expect(theme.value).toBe('toss-light');
  });

  it('storage 조회가 실패해도 toss-light 로 정착한다', async () => {
    vi.mocked(chrome.storage.local.get).mockRejectedValueOnce(new Error('storage unavailable'));

    const { theme, ready, initTheme } = useAgentTheme();
    await initTheme();

    expect(ready.value).toBe(true);
    expect(theme.value).toBe('toss-light');
  });

  it('setTheme는 toss-light 를 저장하고 문서 속성을 갱신한다', async () => {
    vi.mocked(chrome.storage.local.set).mockResolvedValueOnce(undefined);

    const { theme, setTheme } = useAgentTheme();
    await setTheme('toss-light');

    expect(theme.value).toBe('toss-light');
    expect(document.documentElement.dataset.agentTheme).toBe('toss-light');
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ agentTheme: 'toss-light' });
  });
});
