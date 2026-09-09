import {
  inputValueRef,
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

/**
 * How each declared input renders in a UI. The engineer-authored `display` format is
 * authoritative; a pre-authored step that already formats the same input is used as a
 * fallback so older contracts keep working.
 */
export function inputDisplays(capability: Capability): Record<string, ValueRef> {
  const displays: Record<string, ValueRef> = {};
  for (const name of Object.keys(capability.inputSchema)) displays[name] = inputValueRef(capability, name);
  for (const step of capability.steps) {
    if ((step.action.kind !== 'fill' && step.action.kind !== 'select') || step.action.value.kind !== 'input') continue;
    const declared = capability.inputSchema[step.action.value.name]?.display;
    if (!declared) displays[step.action.value.name] = step.action.value;
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

  let annotated = 0;
  actions.forEach((item, index) => {
    if (!item.receipt.target) throw new Error(`Discovery action ${index} has no reusable target`);
    const targetId = `discovered-target-${index + 1}`;
    targets[targetId] = item.receipt.target;
    // A pre-authored step for the same control is engineer knowledge about that control,
    // so it annotates the discovered step. Its absence is not an error: the model is free
    // to find a path the engineer did not enumerate. Policy authorizes the action; the
    // independent success predicate decides whether the run is worth saving at all.
    const contractStep = matchingContractStep(base, item.receipt.target, item.modelAction.kind);
    if (contractStep) annotated += 1;

    let action: ActionSpec;
    if (item.modelAction.kind === 'click') {
      action = { kind: 'click', target: targetId };
    } else {
      const name = item.modelAction.inputRef;
      if (!name) throw new Error(`Discovery action ${index} supplied no input reference`);
      const contractAction = contractStep?.action;
      const contractValue =
        (contractAction?.kind === 'fill' || contractAction?.kind === 'select') &&
        contractAction.value.kind === 'input' &&
        contractAction.value.name === name
          ? contractAction.value
          : undefined;
      action = { kind: item.modelAction.kind, target: targetId, value: contractValue ?? inputValueRef(base, name) };
    }

    const observedPostcondition =
      item.receipt.afterPath !== item.receipt.beforePath
        ? ({ kind: 'urlPath', path: item.receipt.afterPath } as const)
        : undefined;
    steps.push({
      id: `discovered-${index + 1}`,
      action,
      // Without an annotation the effect is unknown, so it is recorded conservatively as
      // reversible: replay executes it, but a reviewer must promote it before any step is
      // treated as irreversible and gated on approval.
      effect: contractStep?.effect ?? 'reversible',
      ...(contractStep?.precondition
        ? { precondition: contractStep.precondition }
        : { precondition: { kind: 'urlPath' as const, path: item.receipt.beforePath } }),
      ...(contractStep?.postcondition
        ? { postcondition: contractStep.postcondition }
        : observedPostcondition
          ? { postcondition: observedPostcondition }
          : {}),
      ...(contractStep?.onTargetMissing ? { onTargetMissing: contractStep.onTargetMissing } : {}),
      timeoutMs: contractStep?.timeoutMs ?? 5_000,
    });
  });

  return {
    ...base,
    version: '1.0.0-discovered',
    // A freshly discovered artifact is unreviewed by construction: steps that matched no
    // pre-authored control carry an inferred effect. It lands as a draft, and unattended
    // replay refuses it until a reviewer promotes it.
    lifecycle: 'draft',
    targets: { ...targets, ...base.targets },
    steps,
    provenance: {
      kind: 'discovered',
      discoveryRunId: runId,
      model,
      note:
        `Executed steps were compiled from the model run; inputs, outputs, outcomes, and success criteria are engineer-authored contract. ` +
        (annotated === actions.length
          ? `All ${actions.length} discovered steps matched a pre-authored control and inherited its effect and checkpoints.`
          : `${annotated} of ${actions.length} discovered steps matched a pre-authored control and inherited its effect and checkpoints; the remaining ${actions.length - annotated} carry observed checkpoints and a conservative reversible effect pending review.`),
    },
  };
}
