import { randomUUID } from 'node:crypto';
import { parseOutputs, type Capability, type Invocation, type Predicate } from '../contracts/artifact.js';
import type { RunResult } from '../contracts/result.js';
import { EvidenceWriter } from '../evidence/writer.js';
import { PolicyError } from '../safety/policy.js';
import { redactionContextFor } from '../safety/redaction.js';
import { TargetResolutionError, type SurfaceAdapter } from '../surfaces/surface.js';

export type InterventionContext = {
  code: string;
  stepId: string;
  resumePredicate: Predicate;
  instruction: string;
  requiresApproval: boolean;
};

export type InterventionResolution = { approved?: boolean };
export type ReplayOptions = {
  allowHumanHandoff?: boolean;
  maxInterventions?: number;
  onIntervention?: (
    surface: SurfaceAdapter,
    intervention: InterventionContext,
  ) => Promise<void | InterventionResolution>;
};

export function describeCheckpoint(predicate: Predicate, capability: Capability): string {
  if (predicate.kind === 'all') {
    return predicate.checks.map((check) => describeCheckpoint(check, capability)).join(' and ');
  }
  if (predicate.kind === 'urlPath') return `the ${predicate.path} screen is visible`;
  const target = capability.targets[predicate.target];
  const name = !target
    ? predicate.target
    : target.kind === 'role'
      ? target.name
      : target.kind === 'label'
        ? target.label
        : target.kind === 'text'
          ? target.text
          : target.kind === 'tableRowLink'
            ? target.linkName
            : target.rowText;
  return predicate.kind === 'visible' ? `${name} is visible` : `${name} matches the requested value`;
}

async function waitForPredicate(
  surface: SurfaceAdapter,
  predicate: Predicate,
  capability: Capability,
  inputs: Invocation,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  do {
    if (await surface.check(predicate, capability.targets, inputs)) return true;
    await new Promise((resolve) => setTimeout(resolve, 80));
  } while (performance.now() < deadline);
  return false;
}

async function activeHandler(surface: SurfaceAdapter, capability: Capability, inputs: Invocation) {
  for (const handler of capability.handlers) {
    if (await surface.check(handler.when, capability.targets, inputs)) return handler;
  }
  return undefined;
}

export function parseUsdMinor(value: string): number {
  const match = value
    .replace(/[$,]/g, '')
    .trim()
    .match(/^(-)?(\d+)\.(\d{2})$/);
  if (!match) throw new Error('Could not parse USD value');
  const magnitude = Number(match[2]) * 100 + Number(match[3]);
  return match[1] ? -magnitude : magnitude;
}

export async function replayCapability(
  surface: SurfaceAdapter,
  capability: Capability,
  inputs: Invocation,
  options: ReplayOptions = {},
): Promise<RunResult> {
  const runId = randomUUID();
  const evidence = new EvidenceWriter(runId, 'evidence/runtime', redactionContextFor(capability, inputs));
  await evidence.initialize('replay', {
    capabilityId: capability.id,
    capabilityVersion: capability.version,
    modelRequests: 0,
    sessionId: surface.session.sessionId,
  });
  let token = surface.session.token();
  let interventionCount = 0;
  const recoveryAttempts = new Map<string, number>();
  const approvedSteps = new Set<string>();

  const captureFailureEvidence = async (name: string): Promise<string[]> => {
    const snapshot = await evidence.snapshot(
      name,
      await surface.sanitizedSnapshot(inputs).catch(() => ({ unavailable: true })),
    );
    const screenshot = evidence.artifactPath(`${name}.png`);
    try {
      await surface.captureFailureScreenshot(screenshot);
      return [snapshot, screenshot];
    } catch (error) {
      await evidence.event('failure.screenshot_unavailable', {
        name,
        error: error instanceof Error ? error.message : String(error),
      });
      return [snapshot];
    }
  };

  type InterventionOutcome = { result?: RunResult; approved: boolean };
  const requestIntervention = async (
    code: string,
    stepId: string,
    resumePredicate: Predicate,
  ): Promise<InterventionOutcome> => {
    const interventionId = randomUUID();
    const snapshot = await evidence.snapshot(`intervention-${interventionId}`, await surface.sanitizedSnapshot(inputs));
    const requiresApproval = code === 'APPROVAL_REQUIRED';
    await evidence.event('intervention.opened', {
      stepId,
      code,
      interventionId,
      snapshot,
      resumePredicate,
      requiresApproval,
    });
    if (!options.allowHumanHandoff || !options.onIntervention) {
      return {
        result: { status: 'intervention_required', code, interventionId, runId },
        approved: false,
      };
    }

    interventionCount += 1;
    if (interventionCount > (options.maxInterventions ?? 2)) {
      const failureEvidence = await captureFailureEvidence(`intervention-budget-${interventionId}`);
      return {
        result: {
          status: 'failed',
          code: 'CHECKPOINT_FAILED',
          stepId,
          expected: 'Intervention budget not to be exceeded',
          observed: String(interventionCount),
          evidence: failureEvidence,
          runId,
        },
        approved: false,
      };
    }

    const humanToken = surface.session.transfer('human');
    const pendingHumanEvents: Promise<void>[] = [];
    surface.setHumanActionListener((action) => {
      pendingHumanEvents.push(evidence.event('human.action', { interventionId, action }));
    });
    await evidence.event('ownership.transferred', {
      interventionId,
      owner: 'human',
      ownershipEpoch: humanToken.epoch,
    });
    const instruction = requiresApproval
      ? `Approve this irreversible step only after reviewing it, and leave the browser where ${describeCheckpoint(resumePredicate, capability)}.`
      : code === 'SESSION_EXPIRED'
        ? `Restore the synthetic session and leave the browser where ${describeCheckpoint(resumePredicate, capability)}.`
        : `Resolve the state and leave the browser where ${describeCheckpoint(resumePredicate, capability)}.`;
    const resolution = await options.onIntervention(surface, {
      code,
      stepId,
      resumePredicate,
      instruction,
      requiresApproval,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await Promise.all(pendingHumanEvents);

    if (!(await waitForPredicate(surface, resumePredicate, capability, inputs, 5_000))) {
      const rejectedEvidence = await captureFailureEvidence(`resume-rejected-${interventionId}`);
      await evidence.event('intervention.resume_rejected', {
        stepId,
        interventionId,
        expected: resumePredicate,
        evidence: rejectedEvidence,
      });
      surface.setHumanActionListener(undefined);
      return {
        result: {
          status: 'failed',
          code: 'CHECKPOINT_FAILED',
          stepId,
          expected: JSON.stringify(resumePredicate),
          observed: 'Human handoff ended outside the required checkpoint',
          evidence: [snapshot, ...rejectedEvidence],
          runId,
        },
        approved: false,
      };
    }
    if (requiresApproval && resolution?.approved !== true) {
      surface.setHumanActionListener(undefined);
      return {
        result: { status: 'intervention_required', code, interventionId, runId },
        approved: false,
      };
    }

    token = surface.session.transfer('automation');
    surface.setHumanActionListener(undefined);
    await evidence.event('intervention.closed', {
      stepId,
      interventionId,
      ownershipEpoch: token.epoch,
      resumeVerified: true,
      ...(requiresApproval ? { approved: true } : {}),
    });
    return { approved: resolution?.approved === true };
  };

  type KnownStateOutcome = { result?: RunResult; restart?: boolean; recovered?: boolean };
  const handleKnownState = async (stepId: string): Promise<KnownStateOutcome> => {
    const handler = await activeHandler(surface, capability, inputs);
    if (!handler) return {};
    await evidence.event('handler.matched', { stepId, handlerId: handler.id, result: handler.result });
    if (handler.result.status === 'business_outcome') return { result: { ...handler.result, runId } };
    if (handler.result.status === 'failed') {
      const failureEvidence = await captureFailureEvidence(`failure-${stepId}`);
      return {
        result: {
          status: 'failed',
          code: handler.result.code,
          stepId,
          expected: 'Normal workflow state',
          observed: handler.id,
          evidence: failureEvidence,
          runId,
        },
      };
    }
    if (handler.result.status === 'intervention_required') {
      const resumePredicate =
        capability.steps[0]?.postcondition ?? ({ kind: 'urlPath', path: capability.entry.path } as const);
      const intervention = await requestIntervention(handler.result.code, stepId, resumePredicate);
      return intervention.result ? { result: intervention.result } : { restart: true };
    }

    const attempts = recoveryAttempts.get(handler.id) ?? 0;
    if (attempts >= handler.result.maxAttempts) {
      const intervention = await requestIntervention('UNEXPECTED_STATE', stepId, handler.result.postcondition);
      return intervention.result ? { result: intervention.result } : { recovered: true };
    }
    recoveryAttempts.set(handler.id, attempts + 1);
    await evidence.event('recovery.started', { stepId, handlerId: handler.id, attempt: attempts + 1 });
    try {
      await surface.act(handler.result.action, capability.targets, inputs, token);
      await evidence.event('action.completed', {
        stepId,
        action: handler.result.action.kind,
        actor: 'recovery',
        ownershipEpoch: token.epoch,
        actionCount: surface.actionCount,
        maxActions: surface.maxActions,
      });
      if (
        await waitForPredicate(
          surface,
          handler.result.postcondition,
          capability,
          inputs,
          capability.steps.find((step) => step.id === stepId)?.timeoutMs ?? 5_000,
        )
      ) {
        await evidence.event('recovery.succeeded', { stepId, handlerId: handler.id, attempt: attempts + 1 });
        return { recovered: true };
      }
    } catch (error) {
      if (error instanceof PolicyError) throw error;
      await evidence.event('recovery.failed', {
        stepId,
        handlerId: handler.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const intervention = await requestIntervention('UNEXPECTED_STATE', stepId, handler.result.postcondition);
    return intervention.result ? { result: intervention.result } : { recovered: true };
  };

  try {
    let stepIndex = 0;
    while (stepIndex < capability.steps.length) {
      const step = capability.steps[stepIndex]!;
      const knownBefore = await handleKnownState(step.id);
      if (knownBefore.result) return knownBefore.result;
      if (knownBefore.restart) {
        stepIndex = 0;
        continue;
      }

      await evidence.event('step.started', {
        stepId: step.id,
        action: step.action.kind,
        effect: step.effect,
        ownershipEpoch: token.epoch,
      });
      if (
        step.precondition &&
        !(await waitForPredicate(surface, step.precondition, capability, inputs, step.timeoutMs))
      ) {
        const known = await handleKnownState(step.id);
        if (known.result) return known.result;
        if (known.restart) {
          stepIndex = 0;
          continue;
        }
        if (known.recovered) continue;
        const intervention = await requestIntervention('UNEXPECTED_STATE', step.id, step.precondition);
        if (intervention.result) return intervention.result;
        continue;
      }

      if (step.effect === 'irreversible' && !approvedSteps.has(step.id)) {
        if (!step.precondition) throw new Error('Irreversible steps require a precondition checkpoint');
        const intervention = await requestIntervention('APPROVAL_REQUIRED', step.id, step.precondition);
        if (intervention.result) return intervention.result;
        if (!intervention.approved) throw new Error('Irreversible step was not approved');
        approvedSteps.add(step.id);
      }

      try {
        await surface.act(step.action, capability.targets, inputs, token);
      } catch (error) {
        const known = await handleKnownState(step.id);
        if (known.result) return known.result;
        if (known.restart) {
          stepIndex = 0;
          continue;
        }
        if (known.recovered) continue;
        if (
          error instanceof TargetResolutionError &&
          error.code === 'TARGET_NOT_FOUND' &&
          step.onTargetMissing &&
          step.precondition &&
          (await surface.check(step.precondition, capability.targets, inputs))
        ) {
          await evidence.event('business_outcome', {
            stepId: step.id,
            code: step.onTargetMissing.code,
            screenConfirmed: true,
          });
          return { ...step.onTargetMissing, runId };
        }
        if (
          error instanceof PolicyError ||
          (error instanceof TargetResolutionError && error.code === 'AMBIGUOUS_TARGET')
        ) {
          throw error;
        }
        if (!step.precondition) throw error;
        const intervention = await requestIntervention('UNEXPECTED_STATE', step.id, step.precondition);
        if (intervention.result) return intervention.result;
        continue;
      }
      await evidence.event('action.completed', {
        stepId: step.id,
        action: step.action.kind,
        effect: step.effect,
        ownershipEpoch: token.epoch,
        actionCount: surface.actionCount,
        maxActions: surface.maxActions,
      });

      const knownAfter = await handleKnownState(step.id);
      if (knownAfter.result) return knownAfter.result;
      if (knownAfter.restart) {
        stepIndex = 0;
        continue;
      }

      if (
        step.postcondition &&
        !(await waitForPredicate(surface, step.postcondition, capability, inputs, step.timeoutMs))
      ) {
        const known = await handleKnownState(step.id);
        if (known.result) return known.result;
        if (known.restart) {
          stepIndex = 0;
          continue;
        }
        if (!known.recovered) {
          const failureEvidence = await captureFailureEvidence(`timeout-${step.id}`);
          await evidence.event('run.failed', {
            code: 'TIMEOUT',
            stepId: step.id,
            expected: step.postcondition,
            evidence: failureEvidence,
          });
          return {
            status: 'failed',
            code: 'TIMEOUT',
            stepId: step.id,
            expected: JSON.stringify(step.postcondition),
            observed: 'Postcondition did not become true before the deadline',
            evidence: failureEvidence,
            runId,
          };
        }
      }
      await evidence.event('step.completed', { stepId: step.id });
      stepIndex += 1;
    }

    if (!(await surface.check(capability.success.predicate, capability.targets, inputs))) {
      const intervention = await requestIntervention(
        'UNEXPECTED_STATE',
        'final-verification',
        capability.success.predicate,
      );
      if (intervention.result) return intervention.result;
    }

    const output: Record<string, string | number> = {};
    for (const [name, source] of Object.entries(capability.success.outputs)) {
      if (source.kind === 'constant') output[name] = source.value;
      if (source.kind === 'input') output[name] = inputs[source.name]!;
      if (source.kind === 'extract') {
        const target = capability.targets[source.target];
        if (!target) throw new Error(`Unknown output target ${source.target}`);
        const text = await surface.read(target, inputs);
        output[name] = source.parse === 'usdMinor' ? parseUsdMinor(text) : text;
      }
    }
    const outputs = parseOutputs(capability, output);
    const snapshot = await evidence.snapshot('success', await surface.sanitizedSnapshot(inputs));
    await evidence.event('run.succeeded', { outputKeys: Object.keys(outputs), snapshot });
    return { status: 'success', outputs, runId };
  } catch (error) {
    const failureEvidence = await captureFailureEvidence('failure-exception');
    const code =
      error instanceof PolicyError
        ? 'POLICY_DENIED'
        : error instanceof TargetResolutionError && error.code === 'AMBIGUOUS_TARGET'
          ? 'AMBIGUOUS_TARGET'
          : 'CHECKPOINT_FAILED';
    await evidence.event('run.failed', { code, error: error instanceof Error ? error.message : String(error) });
    return {
      status: 'failed',
      code,
      expected: 'Step to complete under policy',
      observed: error instanceof Error ? error.message : String(error),
      evidence: failureEvidence,
      runId,
    };
  } finally {
    surface.setHumanActionListener(undefined);
  }
}
