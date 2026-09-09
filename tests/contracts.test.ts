import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { capabilitySchema, parseInvocation, resolveValue } from '../src/contracts/artifact.js';
import { assertTenantBindingCompatible, loadTenantBinding } from '../src/contracts/binding.js';
import { assertActionAllowed, assertUrlAllowed, loadPolicy, PolicyError } from '../src/safety/policy.js';
import { redact, redactionContextFor } from '../src/safety/redaction.js';
import { SessionController } from '../src/runtime/session.js';
import { expectedInputFor } from '../src/discovery/compiler.js';

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
