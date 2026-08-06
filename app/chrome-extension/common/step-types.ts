// step-types.ts — re-export shared constants to keep single source of truth
export { STEP_TYPES } from 'chrome-mcp-scalemaker-shared';
export type StepTypeConst =
  (typeof import('chrome-mcp-scalemaker-shared'))['STEP_TYPES'][keyof (typeof import('chrome-mcp-scalemaker-shared'))['STEP_TYPES']];
