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
