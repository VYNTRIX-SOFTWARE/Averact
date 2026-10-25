import test from 'node:test';
import assert from 'node:assert/strict';
import { AveractError, runAction } from '../dist/index.js';

const context = { actorId: 'person-1', roles: ['buyer'] };
function setup({ policy = () => ({ kind: 'allow' }), verify = () => true, effect = 'write', failAuditOn } = {}) {
  const events = [], writes = [];
  const contract = {
    name: 'demo.write', effect,
    validate: x => Number.isSafeInteger(x?.amount) && x.amount > 0,
    policy,
    execute: async (input, executionContext) => {
      writes.push({ input, executionContext });
      return { saved: input.amount };
    },
    verify,
  };
  const adapters = { audit: { record: async event => {
    if (event.type === failAuditOn) throw new Error('storage unavailable');
    events.push(event);
  }}};
  const req = (amount = 20) => ({ input: { amount }, context, idempotencyKey: 'order-1' });
  return { events, writes, contract, adapters, req };
}
test('allowed operation succeeds and emits audit events', async () => {
  const x = setup(); const result = await runAction(x.contract, x.req(), x.adapters);
  assert.equal(result.status, 'completed');
  assert.equal(result.output.saved, 20);
  assert.deepEqual(x.events.map(e => e.type), ['execution_started', 'completed']);
  assert.equal(x.events[0].input, undefined);
  assert.equal(x.writes[0].executionContext.idempotencyKey, 'order-1');
});
test('invalid input does not execute', async () => {
  const x = setup(); assert.equal((await runAction(x.contract, x.req(-1), x.adapters)).status, 'invalid_request');
  assert.equal(x.writes.length, 0);
});
test('write without idempotency key is rejected', async () => {
  const x = setup(); assert.equal((await runAction(x.contract, { input: { amount: 20 }, context }, x.adapters)).status, 'invalid_request');
  assert.equal(x.writes.length, 0);
});
test('policy denial blocks execution', async () => {
  const x = setup({ policy: () => ({ kind: 'deny', reason: 'not authorized' }) });
  assert.equal((await runAction(x.contract, x.req(), x.adapters)).status, 'denied');
  assert.equal(x.writes.length, 0);
});
test('missing approval adapter leaves operation pending', async () => {
  const x = setup({ policy: () => ({ kind: 'approval_required', reason: 'manager' }) });
  assert.equal((await runAction(x.contract, x.req(), x.adapters)).status, 'approval_required');
  assert.equal(x.writes.length, 0);
});
test('unapproved operation is denied', async () => {
  const x = setup({ policy: () => ({ kind: 'approval_required', reason: 'manager' }) });
  x.adapters.approvals = { check: async () => false };
  assert.equal((await runAction(x.contract, x.req(), x.adapters)).status, 'denied');
  assert.equal(x.writes.length, 0);
});
test('trusted approval callback can authorize', async () => {
  const x = setup({ policy: () => ({ kind: 'approval_required', reason: 'manager' }) });
  x.adapters.approvals = { check: async r => r.input.amount === 20 };
  assert.equal((await runAction(x.contract, x.req(), x.adapters)).status, 'completed');
  assert.equal(x.writes.length, 1);
});
test('failed outcome check reports action may have happened', async () => {
  const x = setup({ verify: () => false });
  assert.equal((await runAction(x.contract, x.req(), x.adapters)).status, 'verification_failed');
  assert.equal(x.writes.length, 1);
});
test('pre-execution audit failure blocks execution', async () => {
  const x = setup({ failAuditOn: 'execution_started' });
  await assert.rejects(() => runAction(x.contract, x.req(), x.adapters),
    e => e instanceof AveractError && e.phase === 'audit' && !e.mayHaveExecuted);
  assert.equal(x.writes.length, 0);
});
test('post-execution audit failure signals side effect uncertainty', async () => {
  const x = setup({ failAuditOn: 'completed' });
  await assert.rejects(() => runAction(x.contract, x.req(), x.adapters),
    e => e instanceof AveractError && e.phase === 'audit' && e.mayHaveExecuted);
  assert.equal(x.writes.length, 1);
});
test('invalid verdict never falls through to execute', async () => {
  const x = setup({ policy: () => ({ kind: 'unknown' }) });
  await assert.rejects(() => runAction(x.contract, x.req(), x.adapters),
    e => e instanceof AveractError && e.phase === 'policy' && !e.mayHaveExecuted);
  assert.equal(x.writes.length, 0);
});
test('truthy non-boolean approval does not grant access', async () => {
  const x = setup({ policy: () => ({ kind: 'approval_required', reason: 'manager' }) });
  x.adapters.approvals = { check: async () => 'yes' };
  assert.equal((await runAction(x.contract, x.req(), x.adapters)).status, 'denied');
  assert.equal(x.writes.length, 0);
});
test('truthy non-boolean verification does not count as verified', async () => {
  const x = setup({ verify: () => 'yes' });
  assert.equal((await runAction(x.contract, x.req(), x.adapters)).status, 'verification_failed');
});
function isCorrelatedError(phase, mayHaveExecuted) {
  return error => error instanceof AveractError
    && error.phase === phase
    && error.mayHaveExecuted === mayHaveExecuted
    && /^[0-9a-f-]{36}$/.test(error.operationId);
}

test('validator throw is audited and cannot execute', async () => {
  const x = setup(); x.contract.validate = () => { throw new Error('bad schema'); };
  let failure;
  await assert.rejects(() => runAction(x.contract, x.req(), x.adapters), error => {
    failure = error;
    return isCorrelatedError('input', false)(error);
  });
  assert.equal(failure.cause.message, 'bad schema');
  assert.deepEqual(x.events.map(e => e.type), ['input_rejected']);
  assert.equal(x.events[0].operationId, failure.operationId);
  assert.equal(x.writes.length, 0);
});
test('policy throw fails closed and writes no sensitive details into audit event', async () => {
  const x = setup({ policy: async () => { throw new Error('internal secret'); } });
  await assert.rejects(() => runAction(x.contract, x.req(), x.adapters), isCorrelatedError('policy', false));
  assert.deepEqual(x.events.map(e => e.type), ['policy_failed']);
  assert.equal(x.events[0].reason, undefined);
  assert.equal(x.writes.length, 0);
});
test('policy-denial audit sink outage fails closed', async () => {
  const x = setup({ policy: () => ({ kind: 'deny', reason: 'stop' }), failAuditOn: 'policy_denied' });
  await assert.rejects(() => runAction(x.contract, x.req(), x.adapters), isCorrelatedError('audit', false));
  assert.equal(x.writes.length, 0);
});
test('approval adapter outage blocks execution', async () => {
  const x = setup({ policy: () => ({ kind: 'approval_required', reason: 'manager' }) });
  x.adapters.approvals = { check: async () => { throw new Error('approval system offline'); } };
  await assert.rejects(() => runAction(x.contract, x.req(), x.adapters), isCorrelatedError('approval', false));
  assert.deepEqual(x.events.map(e => e.type), ['approval_failed']);
  assert.equal(x.writes.length, 0);
});
test('approval adapter gets trusted identity and matching operation ID', async () => {
  const x = setup({ policy: () => ({ kind: 'approval_required', reason: 'manager' }) });
  let check;
  x.adapters.approvals = { check: async req => { check = req; return true; } };
  const result = await runAction(x.contract, x.req(), x.adapters);
  assert.equal(result.status, 'completed');
  assert.equal(check.context, context);
  assert.equal(check.operationId, result.operationId);
  assert.equal(check.idempotencyKey, 'order-1');
  assert.equal(check.actionName, x.contract.name);
});
test('execution failure is uncertain and runner never retries automatically', async () => {
  const x = setup();
  let attempts = 0;
  x.contract.execute = async () => { attempts++; throw new Error('lost response'); };
  await assert.rejects(() => runAction(x.contract, x.req(), x.adapters), isCorrelatedError('execution', true));
  assert.equal(attempts, 1);
  assert.deepEqual(x.events.map(e => e.type), ['execution_started', 'execution_failed']);
});
test('execution error followed by audit outage still reports possible side effect', async () => {
  const x = setup({ failAuditOn: 'execution_failed' });
  let attempts = 0;
  x.contract.execute = async () => { attempts++; throw new Error('timeout'); };
  await assert.rejects(() => runAction(x.contract, x.req(), x.adapters), isCorrelatedError('audit', true));
  assert.equal(attempts, 1);
});
test('verification throw does not retry and has uncertain outcome', async () => {
  const x = setup({ verify: () => { throw new Error('verifier offline'); } });
  await assert.rejects(() => runAction(x.contract, x.req(), x.adapters), isCorrelatedError('verification', true));
  assert.equal(x.writes.length, 1);
  assert.deepEqual(x.events.map(e => e.type), ['execution_started', 'verification_error']);
});
test('failed verifier emits failure audit without completion', async () => {
  const x = setup({ verify: () => false });
  const result = await runAction(x.contract, x.req(), x.adapters);
  assert.equal(result.status, 'verification_failed');
  assert.deepEqual(x.events.map(e => e.type), ['execution_started', 'verification_failed']);
});
test('post-execution verification audit outage marks possible side effect', async () => {
  const x = setup({ verify: () => false, failAuditOn: 'verification_failed' });
  await assert.rejects(() => runAction(x.contract, x.req(), x.adapters), isCorrelatedError('audit', true));
  assert.equal(x.writes.length, 1);
});
test('read actions need no idempotency key', async () => {
  const x = setup({ effect: 'read' });
  const result = await runAction(x.contract, { input: { amount: 3 }, context }, x.adapters);
  assert.equal(result.status, 'completed');
});
test('blank trusted actor ID blocks operation', async () => {
  const x = setup();
  const result = await runAction(x.contract, { ...x.req(), context: { actorId: '  ', roles: [] } }, x.adapters);
  assert.equal(result.status, 'invalid_request');
  assert.deepEqual(x.events.map(e => e.type), ['input_rejected']);
  assert.equal(x.writes.length, 0);
});
test('whitespace idempotency key cannot authorize a write', async () => {
  const x = setup();
  const result = await runAction(x.contract, { ...x.req(), idempotencyKey: '  ' }, x.adapters);
  assert.equal(result.status, 'invalid_request');
  assert.equal(x.writes.length, 0);
});
test('runtime does NOT deduplicate: backend must enforce atomic idempotency', async () => {
  const x = setup();
  await runAction(x.contract, x.req(), x.adapters);
  await runAction(x.contract, x.req(), x.adapters);
  assert.equal(x.writes.length, 2);
  assert.notEqual(x.writes[0].executionContext.operationId, x.writes[1].executionContext.operationId);
});
