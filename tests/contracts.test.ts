import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { capabilitySchema, parseInvocation, resolveValue } from '../src/contracts/artifact.js';
import { assertTenantBindingCompatible, loadTenantBinding } from '../src/contracts/binding.js';
import { assertActionAllowed, assertUrlAllowed, loadPolicy, PolicyError } from '../src/safety/policy.js';
import { redact, redactionContextFor } from '../src/safety/redaction.js';
import { SessionController } from '../src/runtime/session.js';
import { compileCapability, expectedInputFor } from '../src/discovery/compiler.js';
import { parseUsdMinor } from '../src/runtime/replay-engine.js';

test('example capability is schema-valid and inputs remain typed', async () => {
  const artifact = capabilitySchema.parse(
    JSON.parse(await readFile('capabilities/prepare-stop-payment.example.json', 'utf8')),
  );
  assert.equal(artifact.schemaVersion, '1.0');
  assert.throws(() => parseInvocation(artifact, { memberId: '1' }));
  const input = parseInvocation(artifact, {
    memberId: '10001',
    accountSuffix: '2468',
    checkNumber: '4812',
    amountMinor: 12550,
    reason: 'lost',
  });
  assert.equal(
    resolveValue({ kind: 'input', name: 'amountMinor', format: { kind: 'minorUnits', scale: 2, prefix: '$' } }, input),
    '$125.50',
  );
  const binding = await loadTenantBinding('config/tenants/cedar.json');
  assertTenantBindingCompatible(artifact, binding);
  assert.throws(
    () =>
      assertTenantBindingCompatible(artifact, { ...binding, reviewedFor: { ...binding.reviewedFor, version: '8.0' } }),
    /outside the artifact compatibility set/,
  );
});

test('capability validation rejects dangling target and input references', async () => {
  const artifact = JSON.parse(await readFile('capabilities/prepare-stop-payment.example.json', 'utf8'));
  artifact.steps[0].postcondition = { kind: 'visible', target: 'missing-target' };
  artifact.steps[1].action.value = { kind: 'input', name: 'missing-input' };
  assert.throws(() => capabilitySchema.parse(artifact), /Unknown (target|input) reference/);
});

test('capability validation enforces target references and declared types', async () => {
  const source = JSON.parse(await readFile('capabilities/prepare-stop-payment.example.json', 'utf8'));
  const rowReference = structuredClone(source);
  rowReference.targets['account-link'].rowTexts.push({ kind: 'input', name: 'undeclared' });
  assert.throws(() => capabilitySchema.parse(rowReference), /Unknown input reference/);

  const contradictoryInput = structuredClone(source);
  contradictoryInput.inputSchema.amountMinor.type = 'string';
  assert.throws(() => capabilitySchema.parse(contradictoryInput), /requires an integer input/);

  const contradictoryOutput = structuredClone(source);
  contradictoryOutput.outputSchema.amountMinor.type = 'string';
  assert.throws(() => capabilitySchema.parse(contradictoryOutput), /binding produces integer/);
});

test('contract semantics are generic across capability names and policy profiles', async () => {
  const source = JSON.parse(await readFile('capabilities/prepare-stop-payment.example.json', 'utf8'));
  source.policyProfile = 'another-reviewed-policy-v2';
  source.inputSchema.customerKey = source.inputSchema.memberId;
  delete source.inputSchema.memberId;
  source.steps[1].action.value.name = 'customerKey';
  source.steps[1].postcondition.value.name = 'customerKey';
  source.steps[3].precondition.checks[1].value.name = 'customerKey';
  source.success.predicate.checks[1].value.name = 'customerKey';
  const artifact = capabilitySchema.parse(source);
  const target = artifact.targets['member-input'];
  assert.ok(target);
  const expected = expectedInputFor(artifact, target, 'fill');
  assert.deepEqual(expected, { kind: 'input', name: 'customerKey' });
});

test('policy rejects deceptive origins and the financial commit control', async () => {
  const policy = await loadPolicy();
  assertUrlAllowed('http://127.0.0.1:3000/workspace/search', policy);
  assert.throws(() => assertUrlAllowed('http://127.0.0.1.evil.test:3000/workspace/search', policy), PolicyError);
  assert.throws(() => assertUrlAllowed('http://127.0.0.1:3000/workspace-escape', policy), PolicyError);
  assert.throws(() => assertUrlAllowed('http://127.0.0.1:3000/workspace/submit', policy), PolicyError);
  assert.throws(() => assertActionAllowed('click', 'Submit stop payment', policy), PolicyError);
});

test('redaction removes sensitive keys and canary values', () => {
  const encoded = JSON.stringify(
    redact({ memberId: '10001', password: 'hunter2', message: 'token abc and member 10001' }),
  );
  assert.equal(encoded.includes('hunter2'), false);
  assert.equal(encoded.includes('10001'), false);
});

test('artifact-sensitive values and unfamiliar PII are redacted', async () => {
  const artifact = capabilitySchema.parse(
    JSON.parse(await readFile('capabilities/prepare-stop-payment.example.json', 'utf8')),
  );
  const inputs = parseInvocation(artifact, {
    memberId: '10001',
    accountSuffix: '2468',
    checkNumber: '4812',
    amountMinor: 12550,
    reason: 'lost',
  });
  const value = redact(
    {
      fullName: 'Avery Stone',
      message: 'Email avery.stone@example.test, SSN 123-45-6789, check 4812, account 2468, amount $125.50.',
    },
    '',
    redactionContextFor(artifact, inputs),
  );
  const encoded = JSON.stringify(value);
  for (const secret of ['Avery Stone', 'avery.stone@example.test', '123-45-6789', '4812', '2468', '$125.50'])
    assert.equal(encoded.includes(secret), false);
});

test('ownership epochs reject stale automation after human takeover', () => {
  const session = new SessionController();
  const oldAutomation = session.token();
  const human = session.transfer('human');
  assert.throws(() => session.assert(oldAutomation, 'automation'));
  session.assert(human, 'human');
  const newAutomation = session.transfer('automation');
  assert.throws(() => session.assert(human, 'human'));
  session.assert(newAutomation, 'automation');
});

test('discovery compiles a path the engineer never pre-authored', async () => {
  const base = capabilitySchema.parse(
    JSON.parse(await readFile('capabilities/prepare-stop-payment.example.json', 'utf8')),
  );
  const preAuthored = base.targets['search-button'];
  assert.ok(preAuthored);

  const compiled = compileCapability(
    base,
    [
      {
        modelAction: { kind: 'click' },
        receipt: {
          action: 'click',
          target: { kind: 'role', frame: 'workspace', role: 'link', name: 'Skip notice', exact: true },
          beforePath: '/workspace/search',
          afterPath: '/workspace/notice',
        },
        eventIndex: 0,
      },
      {
        modelAction: { kind: 'click' },
        receipt: {
          action: 'click',
          target: preAuthored,
          beforePath: '/workspace/search',
          afterPath: '/workspace/member',
        },
        eventIndex: 1,
      },
      {
        modelAction: { kind: 'fill', inputRef: 'amountMinor' },
        receipt: {
          action: 'fill',
          target: { kind: 'tableRowControl', frame: 'workspace', rowText: 'Amount override', control: 'input' },
          beforePath: '/workspace/stop-payment',
          afterPath: '/workspace/stop-payment',
        },
        eventIndex: 2,
      },
    ],
    'discovery-run-under-test',
    'test-model',
  );
  const artifact = capabilitySchema.parse(compiled);
  const [, unmatchedClick, matchedClick, unmatchedFill] = artifact.steps;

  // A control with no pre-authored step is still compiled, with checkpoints taken from
  // what the run actually observed and a conservative effect.
  assert.ok(unmatchedClick);
  assert.equal(unmatchedClick.effect, 'reversible');
  assert.deepEqual(unmatchedClick.precondition, { kind: 'urlPath', path: '/workspace/search' });
  assert.deepEqual(unmatchedClick.postcondition, { kind: 'urlPath', path: '/workspace/notice' });

  // A control the engineer did describe still contributes its effect and checkpoints.
  assert.ok(matchedClick);
  assert.equal(matchedClick.effect, 'read');
  assert.deepEqual(matchedClick.postcondition, { kind: 'urlPath', path: '/workspace/member' });

  // An unmatched fill takes its display format from the declared input, not from a step.
  assert.ok(unmatchedFill);
  assert.equal(unmatchedFill.action.kind, 'fill');
  if (unmatchedFill.action.kind === 'fill') {
    assert.deepEqual(unmatchedFill.action.value, {
      kind: 'input',
      name: 'amountMinor',
      format: { kind: 'minorUnits', scale: 2 },
    });
  }
  assert.match(artifact.provenance.note ?? '', /1 of 3 discovered steps matched a pre-authored control/);
});

test('USD extraction preserves sign and rejects unparseable values', () => {
  assert.equal(parseUsdMinor('$1,234.56'), 123456);
  assert.equal(parseUsdMinor('0.00'), 0);
  assert.equal(parseUsdMinor('-1.50'), -150);
  assert.equal(parseUsdMinor('$-1.50'), -150);
  assert.throws(() => parseUsdMinor('12'), /Could not parse USD value/);
  assert.throws(() => parseUsdMinor('1.5'), /Could not parse USD value/);
});
