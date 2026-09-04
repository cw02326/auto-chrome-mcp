// engine/logging/run-logger.ts — run logs, overlay and persistence
import type { RunLogEntry, RunRecord, Flow } from '../../types';
import { appendRun } from '../../flow-store';
import { TOOL_NAMES } from 'auto-chrome-mcp-shared';
import { handleCallTool } from '@/entrypoints/background/tools';
import { resolveRunTab, runToolArgs, type RunTabContext } from '../tab-context';

export class RunLogger {
  private logs: RunLogEntry[] = [];

  /**
   * @param runId  Identifier of the run these logs belong to.
   * @param tab    The run's pinned tab. The overlay is drawn on this tab only,
   *               never on whichever tab the user happens to be viewing.
   */
  constructor(
    private runId: string,
    private tab: RunTabContext,
  ) {}

  /** Send an overlay command to the run tab; silently skipped if it is gone. */
  private async sendOverlay(payload: Record<string, unknown>): Promise<void> {
    try {
      const tabId = await resolveRunTab(this.tab);
      await chrome.tabs.sendMessage(tabId, { action: 'rr_overlay', ...payload } as any);
    } catch {}
  }

  push(e: RunLogEntry) {
    this.logs.push(e);
  }

  getLogs() {
    return this.logs;
  }

  async overlayInit() {
    await this.sendOverlay({ cmd: 'init' });
  }

  async overlayAppend(text: string) {
    await this.sendOverlay({ cmd: 'append', text });
  }

  async overlayDone() {
    await this.sendOverlay({ cmd: 'done' });
  }

  async screenshotOnFailure() {
    try {
      const shot = await handleCallTool({
        name: TOOL_NAMES.BROWSER.COMPUTER,
        args: runToolArgs(this.tab, { action: 'screenshot' }),
      });
      const img = (shot?.content?.find((c: any) => c.type === 'image') as any)?.data as string;
      if (img) this.logs[this.logs.length - 1].screenshotBase64 = img;
    } catch {}
  }

  async persist(flow: Flow, startedAt: number, success: boolean) {
    const record: RunRecord = {
      id: this.runId,
      flowId: flow.id,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      success,
      entries: this.logs,
    };
    await appendRun(record);
  }
}
