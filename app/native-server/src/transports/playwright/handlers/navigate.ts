import type { CdpAttachState } from '../cdp-client.js';

export interface NavigateArgs {
  url: string;
  /** "new_tab" | "current_tab" (default current). */
  newTab?: boolean;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  timeout?: number;
}

/**
 * chrome_navigate — Playwright 측 매핑.
 * Native 측은 chrome.tabs.update 또는 chrome.tabs.create — 우리는 page.goto + context.newPage.
 */
export const navigateHandler = async (
  cdp: CdpAttachState,
  args: NavigateArgs,
): Promise<{ ok: true; url: string; title: string }> => {
  if (!args?.url) {
    throw new Error('navigate: url required');
  }
  const target = args.newTab
    ? await cdp.context.newPage()
    : (cdp.firstPage() ?? (await cdp.context.newPage()));
  await target.goto(args.url, {
    waitUntil: args.waitUntil ?? 'load',
    timeout: args.timeout ?? 30000,
  });
  await target.bringToFront();
  return {
    ok: true,
    url: target.url(),
    title: await target.title(),
  };
};
