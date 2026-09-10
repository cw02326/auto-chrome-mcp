import type { ToolResult } from '@/common/tool-handler';

// computer.ts는 좌표 검증·투영과 도구 경계를 소유하고, 병렬 구현은 이 계약만 공유한다.
export interface ComputerPoint {
  x: number;
  y: number;
}
export type ComputerButton = 'left' | 'right' | 'middle';
export type ExtendedInputAction =
  | 'mouse_down'
  | 'mouse_up'
  | 'key_down'
  | 'key_up'
  | 'drag_path'
  | 'ime_type';
export interface ExtendedInputParams {
  action: ExtendedInputAction | 'hover';
  coordinates?: ComputerPoint;
  button?: ComputerButton;
  key?: string;
  path?: ComputerPoint[];
  text?: string;
  modifiers?: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };
}
export interface ObserveAfterOptions {
  includeImage?: boolean;
  fullResolution?: boolean;
}
export interface ComputerObservationResult {
  observationId?: string;
  stabilization: {
    status: 'stable' | 'timeout' | 'skipped';
    stable: boolean;
    elapsedMs: number;
    samples: number;
    reason?: string;
  };
  observation?: Record<string, unknown>;
  image?: Extract<ToolResult['content'][number], { type: 'image' }>;
}
