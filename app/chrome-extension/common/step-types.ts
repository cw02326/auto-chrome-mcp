// step-types.ts — re-export shared constants to keep single source of truth
export { STEP_TYPES } from 'auto-chrome-mcp-shared';
export type StepTypeConst =
  (typeof import('auto-chrome-mcp-shared'))['STEP_TYPES'][keyof (typeof import('auto-chrome-mcp-shared'))['STEP_TYPES']];
