import type { CdpAttachState } from '../cdp-client.js';

export interface GetContentArgs {
  /** Mode: 'text' (default, page text content) | 'html' (outer HTML). */
  mode?: 'text' | 'html';
  /** Optional selector to scope the extraction. */
  selector?: string;
  /** Max chars to return. default 50_000. */
  maxChars?: number;
}

/**
 * chrome_get_web_content — Playwright page.textContent / page.content / locator.innerHTML.
 */
export const getContentHandler = async (
  cdp: CdpAttachState,
  args: GetContentArgs,
): Promise<{ ok: true; mode: 'text' | 'html'; content: string; truncated: boolean }> => {
  const page = cdp.firstPage();
  if (!page) {
    throw new Error('get_content: no active page (open a tab first)');
  }
  const mode = args.mode ?? 'text';
  const maxChars = args.maxChars ?? 50000;
  let raw = '';

  if (args.selector) {
    const locator = page.locator(args.selector);
    if (mode === 'html') {
      raw =
        (await locator
          .first()
          .innerHTML()
          .catch(() => '')) || '';
    } else {
      raw =
        (await locator
          .first()
          .innerText()
          .catch(() => '')) || '';
    }
  } else {
    if (mode === 'html') {
      raw = await page.content();
    } else {
      raw = (await page.textContent('body').catch(() => '')) || '';
    }
  }

  const truncated = raw.length > maxChars;
  return {
    ok: true,
    mode,
    content: truncated ? raw.slice(0, maxChars) : raw,
    truncated,
  };
};
