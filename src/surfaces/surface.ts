import type { ActionSpec, Invocation, Predicate, TargetSpec } from '../contracts/artifact.js';
import type { OwnershipToken, SessionController } from '../runtime/session.js';

export type ActionReceipt = {
  action: ActionSpec['kind'];
  target?: TargetSpec;
  beforePath: string;
  afterPath: string;
};

export type HumanAction = {
  event: 'click' | 'change';
  tag: string;
  name: string;
};

export class TargetResolutionError extends Error {
  constructor(
    readonly code: 'AMBIGUOUS_TARGET' | 'TARGET_NOT_FOUND',
    message: string,
  ) {
    super(message);
  }
}

export interface SurfaceAdapter {
  readonly session: SessionController;
  readonly maxActions: number;
  readonly actionCount: number;
  act(
    action: ActionSpec,
    targets: Record<string, TargetSpec>,
    inputs: Invocation,
    token: OwnershipToken,
  ): Promise<ActionReceipt>;
  check(predicate: Predicate, targets: Record<string, TargetSpec>, inputs: Invocation): Promise<boolean>;
  read(target: TargetSpec, inputs: Invocation): Promise<string>;
  sanitizedSnapshot(inputs: Invocation): Promise<unknown>;
  captureFailureScreenshot(path: string): Promise<void>;
  setHumanActionListener(listener?: (action: HumanAction) => void | Promise<void>): void;
}
