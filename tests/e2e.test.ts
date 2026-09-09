import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { capabilitySchema, parseInvocation } from '../src/contracts/artifact.js';
import { assertTenantBindingCompatible, loadTenantBinding } from '../src/contracts/binding.js';
import { OllamaModel } from '../src/discovery/ollama.js';
import { loadPolicy } from '../src/safety/policy.js';
import { replayCapability } from '../src/runtime/replay-engine.js';
import { PlaywrightSurface } from '../src/surfaces/playwright-surface.js';
import { PolicyError } from '../src/safety/policy.js';
import type { Observation } from '../src/surfaces/playwright-surface.js';

async function target(port: number, scenario: string, environment: Record<string, string> = {}): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'target/server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment, LEGACYBANK_PORT: String(port), LEGACYBANK_SCENARIO: scenario },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Target server did not start')), 5000);
    child.stdout?.on('data', (data) => {
      if (String(data).includes('legacybank.ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => reject(new Error(`Target server exited ${code}`)));
  });
  return child;
}

const capability = capabilitySchema.parse(
  JSON.parse(await readFile('capabilities/prepare-stop-payment.discovered.json', 'utf8')),
);

async function withSurface(
  port: number,
  scenario: string,
  run: (surface: PlaywrightSurface) => Promise<void>,
  environment: Record<string, string> = {},
  frameTitle = 'Servicing workspace',
  maxActions?: number,
): Promise<void> {
  const server = await target(port, scenario, environment);
  const baseUrl = `http://127.0.0.1:${port}/servicing`;
  const policy = await loadPolicy();
  policy.allowedOrigins.push(`http://127.0.0.1:${port}`);
  if (maxActions !== undefined) policy.maxActions = maxActions;
  const surface = await PlaywrightSurface.launch({ baseUrl, policy, frameTitle });
  try {
    await run(surface);
  } finally {
    await surface.close();
    server.kill('SIGTERM');
  }
}

test('Ollama decisions fail within the configured request timeout', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.flushHeaders();
    response.write('{"message":');
  });
  server.listen(3140, '127.0.0.1');
  await once(server, 'listening');
  const model = new OllamaModel('test-model', 'http://127.0.0.1:3140', 50);
  const observation: Observation = {
    revision: 1,
    url: 'http://127.0.0.1:3140/workspace/search',
    path: '/workspace/search',
    title: 'Member search',
    text: '',
    controls: [],
  };
  try {
    await assert.rejects(model.decide('Test timeout', [], {}, observation, []), /timed out after 50ms/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const [index, tenant] of ['cedar', 'harbor'].entries()) {
  test(`same artifact replays through the ${tenant} tenant binding`, async () => {
    const binding = await loadTenantBinding(`config/tenants/${tenant}.json`);
    assertTenantBindingCompatible(capability, binding);
    await withSurface(
      3130 + index,
      'normal',
      async (surface) => {
        const inputs = parseInvocation(
          capability,
          JSON.parse(await readFile('examples/stop-payment-replay.json', 'utf8')),
        );
        const result = await replayCapability(surface, capability, inputs);
        assert.equal(result.status, 'success');
      },
      { LEGACYBANK_TENANT: tenant },
      binding.frameTitle,
    );
  });
}

test('replay succeeds with a second parameter set and extracts UI outputs', async () => {
  await withSurface(3101, 'normal', async (surface) => {
    const inputs = parseInvocation(
      capability,
      JSON.parse(await readFile('examples/stop-payment-second-member.json', 'utf8')),
    );
    const result = await replayCapability(surface, capability, inputs);
    assert.equal(result.status, 'success');
    if (result.status === 'success') {
      assert.equal(result.outputs.memberId, '20002');
      assert.equal(result.outputs.accountSuffix, '8642');
      assert.equal(result.outputs.amountMinor, 4200);
      assert.equal(result.outputs.feeMinor, 3000);
      await assert.rejects(
        surface.act({ kind: 'click', target: 'submit-button' }, capability.targets, inputs, surface.session.token()),
        PolicyError,
      );
      const alternateTargets = {
        ...capability.targets,
        'submit-as-text': { kind: 'text' as const, frame: 'workspace', text: 'Submit stop payment', exact: true },
      };
      await assert.rejects(
        surface.act({ kind: 'click', target: 'submit-as-text' }, alternateTargets, inputs, surface.session.token()),
        PolicyError,
      );
      await assert.rejects(surface.page.goto('http://127.0.0.1:3101/workspace/submit'));
    }
  });
});

test('missing member is a business outcome', async () => {
  await withSurface(3102, 'normal', async (surface) => {
    const inputs = parseInvocation(
      capability,
      JSON.parse(await readFile('examples/stop-payment-not-found.json', 'utf8')),
    );
    const result = await replayCapability(surface, capability, inputs);
    assert.deepEqual(
      { status: result.status, code: 'code' in result ? result.code : undefined },
      { status: 'business_outcome', code: 'MEMBER_NOT_FOUND' },
    );
  });
});

test('missing account is a business outcome', async () => {
  await withSurface(3104, 'normal', async (surface) => {
    const inputs = parseInvocation(
      capability,
      JSON.parse(await readFile('examples/stop-payment-account-not-found.json', 'utf8')),
    );
    const result = await replayCapability(surface, capability, inputs);
    assert.deepEqual(
      { status: result.status, code: 'code' in result ? result.code : undefined },
      { status: 'business_outcome', code: 'ACCOUNT_NOT_FOUND' },
    );
  });
});

test('restricted account is an explicit business outcome', async () => {
  await withSurface(3105, 'normal', async (surface) => {
    const inputs = parseInvocation(
      capability,
      JSON.parse(await readFile('examples/stop-payment-restricted.json', 'utf8')),
    );
    const result = await replayCapability(surface, capability, inputs);
    assert.deepEqual(
      { status: result.status, code: 'code' in result ? result.code : undefined },
      { status: 'business_outcome', code: 'ACTION_NOT_PERMITTED' },
    );
  });
});

test('application failure is classified and captured', async () => {
  await withSurface(3106, 'app-error', async (surface) => {
    const inputs = parseInvocation(
      capability,
      JSON.parse(await readFile('examples/stop-payment-success.json', 'utf8')),
    );
    const result = await replayCapability(surface, capability, inputs);
    assert.deepEqual(
      { status: result.status, code: 'code' in result ? result.code : undefined },
      { status: 'failed', code: 'APP_ERROR' },
    );
    if (result.status === 'failed') {
      assert.equal(result.evidence.length, 2);
      const screenshot = result.evidence.find((path) => path.endsWith('.png'));
      assert.ok(screenshot);
      await access(screenshot);
    }
  });
});

test('slow target completes through bounded condition waits', async () => {
  await withSurface(3107, 'slow', async (surface) => {
    const inputs = parseInvocation(
      capability,
      JSON.parse(await readFile('examples/stop-payment-success.json', 'utf8')),
    );
    const result = await replayCapability(surface, capability, inputs);
    assert.equal(result.status, 'success');
  });
});

test('session expiry transfers ownership and resumes the same session', async () => {
  await withSurface(3108, 'session-expired', async (surface) => {
    const inputs = parseInvocation(
      capability,
      JSON.parse(await readFile('examples/stop-payment-success.json', 'utf8')),
    );
    const identity = surface.session.sessionId;
    let interventionSeen = false;
    const result = await replayCapability(surface, capability, inputs, {
      allowHumanHandoff: true,
      onIntervention: async (activeSurface, intervention) => {
        interventionSeen = true;
        assert.equal(intervention.code, 'SESSION_EXPIRED');
        assert.match(intervention.instruction, /Member number is visible/);
        assert.deepEqual(intervention.resumePredicate, capability.steps[0]?.postcondition);
        activeSurface.session.assert(activeSurface.session.token(), 'human');
        await surface.page
          .frameLocator('iframe[title="Servicing workspace"]')
          .getByRole('button', { name: 'Restore synthetic session' })
          .click();
        await surface.page
          .frameLocator('iframe[title="Servicing workspace"]')
          .getByRole('button', { name: 'Search member' })
          .waitFor();
      },
    });
    assert.equal(interventionSeen, true);
    assert.equal(surface.session.sessionId, identity);
    assert.equal(result.status, 'success');
  });
});

test('session expiry before account selection is not misclassified as account missing', async () => {
  await withSurface(3109, 'session-expired-before-account', async (surface) => {
    const inputs = parseInvocation(
      capability,
      JSON.parse(await readFile('examples/stop-payment-success.json', 'utf8')),
    );
    const result = await replayCapability(surface, capability, inputs);
    assert.deepEqual(
      { status: result.status, code: 'code' in result ? result.code : undefined },
      { status: 'intervention_required', code: 'SESSION_EXPIRED' },
    );
  });
});

test('unexpected state supports same-session repair with persisted human action and verified resume', async () => {
  await withSurface(3110, 'unexpected-state', async (surface) => {
    const inputs = parseInvocation(
      capability,
      JSON.parse(await readFile('examples/stop-payment-success.json', 'utf8')),
    );
    const sessionId = surface.session.sessionId;
    const result = await replayCapability(surface, capability, inputs, {
      allowHumanHandoff: true,
      onIntervention: async (activeSurface, intervention) => {
        assert.equal(intervention.code, 'UNEXPECTED_STATE');
        assert.match(intervention.instruction, /\/workspace\/member/);
        assert.deepEqual(intervention.resumePredicate, capability.steps[3]?.precondition);
        activeSurface.session.assert(activeSurface.session.token(), 'human');
        await surface.page
          .frameLocator('iframe[title="Servicing workspace"]')
          .getByRole('link', { name: 'Continue' })
          .click();
        await surface.page
          .frameLocator('iframe[title="Servicing workspace"]')
          .getByRole('heading', { name: 'Member detail' })
          .waitFor();
      },
    });
    assert.equal(result.status, 'success');
    assert.equal(surface.session.sessionId, sessionId);
    const events = await readFile(`evidence/runtime/${result.runId}/events.jsonl`, 'utf8');
    assert.match(events, /"type":"human.action"/);
    assert.match(events, /"resumeVerified":true/);
  });
});

test('known interstitial is recovered once without a model or human', async () => {
  await withSurface(3113, 'known-interstitial', async (surface) => {
    const inputs = parseInvocation(
      capability,
      JSON.parse(await readFile('examples/stop-payment-success.json', 'utf8')),
    );
    const result = await replayCapability(surface, capability, inputs);
    assert.equal(result.status, 'success');
    const events = await readFile(`evidence/runtime/${result.runId}/events.jsonl`, 'utf8');
    assert.equal(events.match(/"type":"recovery.started"/g)?.length, 1);
    assert.equal(events.match(/"type":"recovery.succeeded"/g)?.length, 1);
    assert.match(events, /"actor":"recovery"/);
  });
});

test('failed recovery escalates after its single automatic attempt', async () => {
  await withSurface(3114, 'stubborn-interstitial', async (surface) => {
    const inputs = parseInvocation(
      capability,
      JSON.parse(await readFile('examples/stop-payment-success.json', 'utf8')),
    );
    const result = await replayCapability(surface, capability, inputs);
    assert.deepEqual(
      { status: result.status, code: 'code' in result ? result.code : undefined },
      { status: 'intervention_required', code: 'UNEXPECTED_STATE' },
    );
    const events = await readFile(`evidence/runtime/${result.runId}/events.jsonl`, 'utf8');
    assert.equal(events.match(/"type":"recovery.started"/g)?.length, 1);
  });
});

test('expired postcondition is classified as TIMEOUT with screenshot evidence', async () => {
  await withSurface(3115, 'timeout', async (surface) => {
    const source = structuredClone(capability);
    const searchStep = source.steps.find((step) => {
      if (step.action.kind !== 'click') return false;
      const target = source.targets[step.action.target];
      return target?.kind === 'role' && target.name === 'Search member';
    });
    assert.ok(searchStep);
    searchStep.timeoutMs = 100;
    const timeoutCapability = capabilitySchema.parse(source);
    const inputs = parseInvocation(
      timeoutCapability,
      JSON.parse(await readFile('examples/stop-payment-success.json', 'utf8')),
    );
    const result = await replayCapability(surface, timeoutCapability, inputs);
    assert.deepEqual(
      { status: result.status, code: 'code' in result ? result.code : undefined },
      { status: 'failed', code: 'TIMEOUT' },
    );
    if (result.status === 'failed') assert.ok(result.evidence.some((path) => path.endsWith('.png')));
  });
});

test('irreversible steps require an explicit approval before execution', async () => {
  const source = structuredClone(capability);
  const reviewStep = source.steps.find((step) => {
    if (step.action.kind !== 'click') return false;
    const target = source.targets[step.action.target];
    return target?.kind === 'role' && target.name === 'Continue to review';
  });
  assert.ok(reviewStep);
  reviewStep.effect = 'irreversible';
  const approvalCapability = capabilitySchema.parse(source);

  await withSurface(3116, 'normal', async (surface) => {
    const inputs = parseInvocation(
      approvalCapability,
      JSON.parse(await readFile('examples/stop-payment-success.json', 'utf8')),
    );
    const result = await replayCapability(surface, approvalCapability, inputs);
    assert.deepEqual(
      { status: result.status, code: 'code' in result ? result.code : undefined },
      { status: 'intervention_required', code: 'APPROVAL_REQUIRED' },
    );
  });

  await withSurface(3117, 'normal', async (surface) => {
    const inputs = parseInvocation(
      approvalCapability,
      JSON.parse(await readFile('examples/stop-payment-success.json', 'utf8')),
    );
    const result = await replayCapability(surface, approvalCapability, inputs, {
      allowHumanHandoff: true,
      onIntervention: async (_activeSurface, intervention) => {
        assert.equal(intervention.requiresApproval, true);
        return { approved: true };
      },
    });
    assert.equal(result.status, 'success');
  });
});

test('replay stops before exceeding the policy action budget', async () => {
  await withSurface(
    3111,
    'normal',
    async (surface) => {
      const inputs = parseInvocation(
        capability,
        JSON.parse(await readFile('examples/stop-payment-success.json', 'utf8')),
      );
      const result = await replayCapability(surface, capability, inputs);
      assert.deepEqual(
        { status: result.status, code: 'code' in result ? result.code : undefined },
        { status: 'failed', code: 'POLICY_DENIED' },
      );
      const events = await readFile(`evidence/runtime/${result.runId}/events.jsonl`, 'utf8');
      assert.equal(events.match(/"type":"action.completed"/g)?.length, 1);
      assert.match(events, /Action budget exceeded/);
    },
    {},
    'Servicing workspace',
    1,
  );
});

test('handoff recovery consumes the original action budget', async () => {
  await withSurface(
    3112,
    'session-expired',
    async (surface) => {
      const inputs = parseInvocation(
        capability,
        JSON.parse(await readFile('examples/stop-payment-success.json', 'utf8')),
      );
      const result = await replayCapability(surface, capability, inputs, {
        allowHumanHandoff: true,
        onIntervention: async (_activeSurface, intervention) => {
          assert.equal(intervention.code, 'SESSION_EXPIRED');
          await surface.page
            .frameLocator('iframe[title="Servicing workspace"]')
            .getByRole('button', { name: 'Restore synthetic session' })
            .click();
          await surface.page
            .frameLocator('iframe[title="Servicing workspace"]')
            .getByRole('button', { name: 'Search member' })
            .waitFor();
        },
      });
      assert.deepEqual(
        { status: result.status, code: 'code' in result ? result.code : undefined },
        { status: 'failed', code: 'POLICY_DENIED' },
      );
      const events = await readFile(`evidence/runtime/${result.runId}/events.jsonl`, 'utf8');
      assert.match(events, /"type":"intervention.closed"/);
      assert.match(events, /Action budget exceeded/);
    },
    {},
    'Servicing workspace',
    3,
  );
});

for (const [index, field] of ['memberId', 'accountSuffix', 'checkNumber', 'amountMinor', 'reason'].entries()) {
  test(`final verification rejects a corrupted ${field}`, async () => {
    await withSurface(
      3120 + index,
      'normal',
      async (surface) => {
        const inputs = parseInvocation(
          capability,
          JSON.parse(await readFile('examples/stop-payment-success.json', 'utf8')),
        );
        const result = await replayCapability(surface, capability, inputs);
        assert.notEqual(result.status, 'success');
        assert.deepEqual(
          { status: result.status, code: 'code' in result ? result.code : undefined },
          { status: 'intervention_required', code: 'UNEXPECTED_STATE' },
        );
      },
      { LEGACYBANK_CORRUPT_REVIEW_FIELD: field },
    );
  });
}
