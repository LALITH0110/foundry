import {
  targetSignature,
  type ActionSpec,
  type Capability,
  type TargetSpec,
  type ValueRef,
} from '../contracts/artifact.js';
import type { ActionReceipt } from '../surfaces/surface.js';

type DiscoverableAction = 'click' | 'fill' | 'select';
export type ExecutedDiscoveryAction = {
  modelAction: { kind: DiscoverableAction; inputRef?: string };
  receipt: ActionReceipt;
  eventIndex: number;
};

export function matchingContractStep(
  capability: Capability,
  target: TargetSpec,
  kind: DiscoverableAction,
): Capability['steps'][number] | undefined {
  const signature = targetSignature(target);
  const targetId = Object.entries(capability.targets).find(
    ([, candidate]) => targetSignature(candidate) === signature,
  )?.[0];
  if (!targetId) return undefined;
  return capability.steps.find((step) => step.action.kind === kind && step.action.target === targetId);
}

export function expectedInputFor(
  capability: Capability,
  target: TargetSpec,
  kind: DiscoverableAction,
): ValueRef | undefined {
  const step = matchingContractStep(capability, target, kind);
  return step?.action.kind === 'fill' || step?.action.kind === 'select' ? step.action.value : undefined;
}

export function inputDisplays(capability: Capability): Record<string, ValueRef> {
  const displays: Record<string, ValueRef> = {};
  for (const step of capability.steps) {
    if ((step.action.kind === 'fill' || step.action.kind === 'select') && step.action.value.kind === 'input') {
      displays[step.action.value.name] = step.action.value;
    }
  }
  return displays;
}

export function compileCapability(
  base: Capability,
  actions: ExecutedDiscoveryAction[],
  runId: string,
  model: string,
): Capability {
  const targets: Record<string, TargetSpec> = {};
  const entryStep = base.steps.find((step) => step.action.kind === 'navigate');
  const steps: Capability['steps'] = [
    {
      id: 'open-entry',
      action: { kind: 'navigate', path: base.entry.path },
      effect: entryStep?.effect ?? 'read',
      ...(entryStep?.postcondition ? { postcondition: entryStep.postcondition } : {}),
      timeoutMs: entryStep?.timeoutMs ?? 5_000,
    },
  ];

  actions.forEach((item, index) => {
    if (!item.receipt.target) throw new Error(`Discovery action ${index} has no reusable target`);
    const targetId = `discovered-target-${index + 1}`;
    targets[targetId] = item.receipt.target;
    const contractStep = matchingContractStep(base, item.receipt.target, item.modelAction.kind);
    if (!contractStep) {
      throw new Error(`Executed action ${index} is outside the engineer-authored capability contract`);
    }

    let action: ActionSpec;
    if (item.modelAction.kind === 'click') {
      action = { kind: 'click', target: targetId };
    } else {
      const contractAction = contractStep.action;
      if (contractAction.kind !== 'fill' && contractAction.kind !== 'select') {
        throw new Error(`Contract action for discovery step ${index} does not accept input`);
      }
      action = { kind: item.modelAction.kind, target: targetId, value: contractAction.value };
    }

    const observedPostcondition =
      item.receipt.afterPath !== item.receipt.beforePath
        ? ({ kind: 'urlPath', path: item.receipt.afterPath } as const)
        : undefined;
    steps.push({
      id: `discovered-${index + 1}`,
      action,
      effect: contractStep.effect,
      ...(contractStep.precondition
        ? { precondition: contractStep.precondition }
        : { precondition: { kind: 'urlPath' as const, path: item.receipt.beforePath } }),
      ...(contractStep.postcondition
        ? { postcondition: contractStep.postcondition }
        : observedPostcondition
          ? { postcondition: observedPostcondition }
          : {}),
      ...(contractStep.onTargetMissing ? { onTargetMissing: contractStep.onTargetMissing } : {}),
      timeoutMs: contractStep.timeoutMs,
    });
  });

  return {
    ...base,
    version: '1.0.0-discovered',
    targets: { ...targets, ...base.targets },
    steps,
    provenance: {
      kind: 'discovered',
      discoveryRunId: runId,
      model,
      note: 'Executed steps were compiled from the model run; inputs, outputs, effects, outcomes, and success criteria are engineer-authored contract.',
    },
  };
}
