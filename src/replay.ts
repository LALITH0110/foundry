import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { capabilitySchema, parseInvocation } from './contracts/artifact.js';
import { assertTenantBindingCompatible, bindingTarget, loadTenantBinding } from './contracts/binding.js';
import { loadPolicy } from './safety/policy.js';
import { PlaywrightSurface } from './surfaces/playwright-surface.js';
import { replayCapability } from './runtime/replay-engine.js';

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const artifactPath = argument('--artifact', 'capabilities/prepare-stop-payment.discovered.json')!;
const inputsPath = argument('--inputs');
if (!inputsPath) throw new Error('--inputs is required: a JSON file matching the capability input schema');
const headed = process.argv.includes('--headed');
const allowDraft = process.argv.includes('--allow-draft');

const capability = capabilitySchema.parse(JSON.parse(await readFile(artifactPath, 'utf8')));
const bindingPath = argument('--binding');
const binding = bindingPath ? await loadTenantBinding(bindingPath) : undefined;
if (binding) assertTenantBindingCompatible(capability, binding);
const policy = await loadPolicy();
const defaultOrigin = policy.allowedOrigins[0];
if (!defaultOrigin) throw new Error('Policy declares no allowed origin to replay against');
const baseUrl = argument(
  '--target',
  binding ? bindingTarget(binding) : new URL(capability.entry.path, defaultOrigin).toString(),
)!;
const inputs = parseInvocation(capability, JSON.parse(await readFile(inputsPath, 'utf8')));
const surface = await PlaywrightSurface.launch({
  baseUrl,
  policy,
  headed,
  ...(binding ? { frameTitle: binding.frameTitle } : {}),
});

try {
  const result = await replayCapability(surface, capability, inputs, {
    allowHumanHandoff: headed,
    allowDraft,
    onIntervention: async (activeSurface, intervention) => {
      console.log(`\nAutomation paused: ${intervention.code}`);
      console.log(`Session ${activeSurface.session.sessionId} is now human-controlled.`);
      console.log(intervention.instruction);
      const prompt = createInterface({ input: stdin, output: stdout });
      const answer = await prompt.question(
        intervention.requiresApproval
          ? 'Type APPROVE to authorize this irreversible action, or press Enter to leave it pending: '
          : 'Press Enter only after the required checkpoint is visible... ',
      );
      prompt.close();
      console.log(
        `The runtime will validate ${JSON.stringify(intervention.resumePredicate)} before returning control to automation.`,
      );
      return intervention.requiresApproval ? { approved: answer.trim() === 'APPROVE' } : undefined;
    },
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'success' || result.status === 'business_outcome' ? 0 : 1;
} finally {
  await surface.close();
}
