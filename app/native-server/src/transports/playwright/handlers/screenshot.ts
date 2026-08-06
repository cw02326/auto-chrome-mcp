import type { CdpAttachState } from '../cdp-client.js';

export interface ScreenshotArgs {
  /** capture mode: 'viewport' (default) | 'fullpage' | 'element' (with selector). */
  mode?: 'viewport' | 'fullpage' | 'element';
  selector?: string;
  /** PNG by default; jpeg supported. */
  format?: 'png' | 'jpeg';
  /** jpeg quality (0-100). */
  quality?: number;
}

/**
 * chrome_screenshot — Playwright page.screenshot.
 * Returns base64 PNG/JPEG (MCP image content type 호환).
 */
export const screenshotHandler = async (
  cdp: CdpAttachState,
  args: ScreenshotArgs,
): Promise<{ ok: true; mime: string; base64: string }> => {
  const page = cdp.firstPage();
  if (!page) {
    throw new Error('screenshot: no active page (open a tab first)');
  }
  const mime = args.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const type = args.format === 'jpeg' ? 'jpeg' : 'png';
  let buf: Buffer;
  if (args.mode === 'element' && args.selector) {
    const el = await page.waitForSelector(args.selector, { timeout: 5000 });
    if (!el) throw new Error(`screenshot: selector not found: ${args.selector}`);
    buf = await el.screenshot({ type, quality: args.quality });
  } else {
    buf = await page.screenshot({
      type,
      quality: args.quality,
      fullPage: args.mode === 'fullpage',
    });
  }
  return { ok: true, mime, base64: buf.toString('base64') };
};
