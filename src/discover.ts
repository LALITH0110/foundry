import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { capabilitySchema, parseInvocation, resolveValue } from './contracts/artifact.js';
import { assertTenantBindingCompatible, bindingTarget, loadTenantBinding } from './contracts/binding.js';
import {
  compileCapability,
  expectedInputFor,
  inputDisplays,
  matchingContractStep,
  type ExecutedDiscoveryAction,
} from './discovery/compiler.js';
import { OllamaModel } from './discovery/ollama.js';
import { EvidenceWriter } from './evidence/writer.js';
import { loadPolicy } from './safety/policy.js';
import { redactionContextFor } from './safety/redaction.js';
import { PlaywrightSurface } from './surfaces/playwright-surface.js';

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const goal = argument('--goal', 'Prepare a stop-payment review using the supplied inputs and stop before submitting.')!;
const bindingPath = argument('--binding');
const binding = bindingPath ? await loadTenantBinding(bindingPath) : undefined;
const target = argument('--target', binding ? bindingTarget(binding) : 'http://127.0.0.1:3000/servicing')!;
const outputPath = argument('--out', 'capabilities/prepare-stop-payment.discovered.json')!;
const modelName = argument('--model', process.env.OLLAMA_MODEL ?? 'qwen3:4b')!;
const base = capabilitySchema.parse(
  JSON.parse(await readFile('capabilities/prepare-stop-payment.example.json', 'utf8')),
);
if (binding) assertTenantBindingCompatible(base, binding);
const inputs = parseInvocation(
  base,
  JSON.parse(await readFile(argument('--inputs', 'examples/stop-payment-success.json')!, 'utf8')),
);
const policy = await loadPolicy();
const runId = randomUUID();
const evidence = new EvidenceWriter(runId, 'evidence/runtime', redactionContextFor(base, inputs));
await evidence.initialize('discovery', { goal, model: modelName, target, maxActions: policy.maxActions });

const headed = process.argv.includes('--headed');
const surface = await PlaywrightSurface.launch({
  baseUrl: target,
  policy,
  headed,
  ...(binding ? { frameTitle: binding.frameTitle } : {}),
});
const model = new OllamaModel(modelName, process.env.OLLAMA_BASE_URL);
const executed: ExecutedDiscoveryAction[] = [];
const displayRefs = inputDisplays(base);
const history: Array<{ action: string; result: string }> = [];
let repeatedAction = '';
let repeatedCount = 0;
let rejectedActions = 0;
let completed = false;

async function saveCapability(): Promise<void> {
  const capability = capabilitySchema.parse(compileCapability(base, executed, runId, modelName));
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(capability, null, 2)}\n`);
  await rename(temporary, outputPath);
  const snapshot = await evidence.snapshot('success', await surface.sanitizedSnapshot(inputs));
  await evidence.event('artifact.saved', { outputPath, stepCount: capability.steps.length, snapshot });
  console.log(JSON.stringify({ status: 'success', runId, artifact: outputPath, actions: executed.length }, null, 2));
  completed = true;
}

async function runDiscoveryAttempt(): Promise<void> {
  await surface.act(
    { kind: 'navigate', path: new URL(target).pathname },
    base.targets,
    inputs,
    surface.session.token(),
  );
  await evidence.event('action.completed', {
    action: 'navigate',
    actionCount: surface.actionCount,
    maxActions: surface.maxActions,
  });
  for (let index = 0; index < policy.maxActions; index += 1) {
    const observation = await surface.observe(inputs, displayRefs);
    await evidence.event('observation.captured', {
      index,
      path: observation.path,
      controls: observation.controls.map(({ kind, name, allowedActions, blockedReason }) => ({
        kind,
        name,
        allowedActions,
        blockedReason,
      })),
    });
    if (await surface.check(base.success.predicate, base.targets, inputs)) {
      await evidence.event('success.verified', { index, path: observation.path, verifier: 'artifact-predicate' });
      await saveCapability();
      break;
    }
    const action = await model.decide(goal, Object.keys(base.inputSchema), inputs, observation, history);
    await evidence.event('model.decision', {
      index,
      actionId: action.actionId,
      inputRef: action.inputRef,
      decision: action.decision,
    });

    if (action.actionId === 'finish') {
      if (!(await surface.check(base.success.predicate, base.targets, inputs)))
        throw new Error('Model proposed finish before the independent success predicate passed');
      await saveCapability();
      break;
    }

    const inputRef = action.inputRef === 'none' ? undefined : action.inputRef;
    const selected = observation.controls.find((control) => control.actionId === action.actionId);
    const kind = selected?.allowedActions[0];
    const contractStep = selected && kind ? matchingContractStep(base, selected.target, kind) : undefined;
    const expectedValue = selected && kind ? expectedInputFor(base, selected.target, kind) : undefined;
    const expectedRef = expectedValue?.kind === 'input' ? expectedValue.name : undefined;
    const validInput =
      kind === 'fill' || kind === 'select'
        ? expectedValue?.kind === 'constant'
          ? inputRef === undefined
          : inputRef === expectedRef
        : inputRef === undefined;
    if (!selected || !kind || !contractStep || !validInput) {
      rejectedActions += 1;
      const reason = `Rejected action outside the contract${expectedRef && inputRef !== expectedRef ? `; expected inputRef ${expectedRef}` : ''}`;
      await evidence.event('model.action_rejected', { index, reason, actionId: action.actionId });
      history.push({ action: action.actionId, result: reason });
      if (rejectedActions > 4) throw new Error('Discovery stopped after too many invalid model actions');
      continue;
    }
    const signature = `${observation.path}:${kind}:${selected.kind}:${selected.name}:${selected.context}:${inputRef ?? ''}`;
    repeatedCount = signature === repeatedAction ? repeatedCount + 1 : 1;
    repeatedAction = signature;
    if (repeatedCount > 2) throw new Error(`Dead end: model repeated the same action ${repeatedCount} times`);
    const value = expectedValue ? resolveValue(expectedValue, inputs) : undefined;
    const receipt = await surface.actObserved(selected.id, kind, value, surface.session.token());
    executed.push({ modelAction: { kind, ...(inputRef ? { inputRef } : {}) }, receipt, eventIndex: index });
    history.push({ action: action.actionId, result: `${receipt.beforePath}->${receipt.afterPath}` });
    await evidence.event('action.completed', {
      index,
      kind,
      beforePath: receipt.beforePath,
      afterPath: receipt.afterPath,
      actionCount: surface.actionCount,
      maxActions: surface.maxActions,
    });
  }
  if (!completed) throw new Error('Discovery exhausted the action budget before satisfying the success predicate');
}

try {
  let recoveryAttempted = false;
  while (!completed) {
    try {
      await runDiscoveryAttempt();
    } catch (error) {
      if (!headed || recoveryAttempted) throw error;
      recoveryAttempted = true;
      const interventionId = randomUUID();
      const snapshot = await evidence.snapshot(
        `intervention-${interventionId}`,
        await surface.sanitizedSnapshot(inputs).catch(() => ({ unavailable: true })),
      );
      const humanToken = surface.session.transfer('human');
      const pendingHumanEvents: Promise<void>[] = [];
      surface.setHumanActionListener((action) => {
        pendingHumanEvents.push(evidence.event('human.action', { interventionId, action }));
      });
      await evidence.event('intervention.opened', {
        interventionId,
        code: 'UNEXPECTED_STATE',
        error: error instanceof Error ? error.message : String(error),
        snapshot,
        ownershipEpoch: humanToken.epoch,
      });
      console.log('\nDiscovery paused in the existing browser. Restore the Member search screen, then return here.');
      const prompt = createInterface({ input: stdin, output: stdout });
      await prompt.question('Press Enter after Member search is visible... ');
      prompt.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await Promise.all(pendingHumanEvents);
      const resumePredicate = base.steps[0]?.postcondition;
      if (!resumePredicate || !(await surface.check(resumePredicate, base.targets, inputs)))
        throw new Error('Discovery resume checkpoint rejected');
      const automationToken = surface.session.transfer('automation');
      surface.setHumanActionListener(undefined);
      await evidence.event('intervention.closed', {
        interventionId,
        ownershipEpoch: automationToken.epoch,
        resumeVerified: true,
      });
      executed.splice(0);
      history.splice(0);
      repeatedAction = '';
      repeatedCount = 0;
      rejectedActions = 0;
    }
  }
} catch (error) {
  const snapshot = await evidence.snapshot(
    'failure',
    await surface.sanitizedSnapshot(inputs).catch(() => ({ unavailable: true })),
  );
  const screenshot = evidence.artifactPath('failure.png');
  const screenshotAvailable = await surface
    .captureFailureScreenshot(screenshot)
    .then(() => true)
    .catch(() => false);
  await evidence.event('discovery.failed', {
    error: error instanceof Error ? error.message : String(error),
    evidence: [snapshot, ...(screenshotAvailable ? [screenshot] : [])],
  });
  console.error(error);
  process.exitCode = 1;
} finally {
  await surface.close();
}
