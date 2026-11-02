import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runActionWithReceipt, verifyActionReceipt, AveractError } from '../dist/index.js';
import {
  initializeDemo, createPurchaseOrder, lookupPurchaseOrder, orderStats,
} from '../examples/transaction-safety/db.mjs';

// Requires a real PostgreSQL server and the psql CLI. CI runs this in a separate job.
before(async () => { await initializeDemo(); });
const key = () => 'test-' + randomUUID();
const request = (requestKey, amountMinor = 2300, supplier = 'Synthetic Supplier') =>
  ({ requestKey, amountMinor, supplier });

test('first request commits one order and durable idempotency record', async () => {
  const k = key();
  const result = await createPurchaseOrder(request(k));
  assert.equal(result.replayed, false);
  const stored = await lookupPurchaseOrder(k);
  assert.equal(stored.orderId, result.orderId);
  assert.equal(stored.amountMinor, '2300');
  const counts = await orderStats(k);
  assert.equal(counts.requestCount, 1);
  assert.equal(counts.linkedOrderCount, 1);
});
test('same key and same payload replays original order', async () => {
  const k = key();
  const before = await orderStats(k);
  const first = await createPurchaseOrder(request(k));
  const second = await createPurchaseOrder(request(k));
  const after = await orderStats(k);
  assert.equal(second.replayed, true);
  assert.equal(first.orderId, second.orderId);
  assert.equal(after.allOrderCount - before.allOrderCount, 1);
});
test('16 concurrent same-key writes create exactly one order', async () => {
  const k = key();
  const before = await orderStats(k);
  const results = await Promise.all(Array.from({ length: 16 }, () =>
    createPurchaseOrder(request(k))));
  assert.equal(new Set(results.map(r => r.orderId)).size, 1);
  assert.equal(results.filter(r => r.replayed === false).length, 1);
  assert.equal(results.filter(r => r.replayed === true).length, 15);
  const after = await orderStats(k);
  assert.equal(after.allOrderCount - before.allOrderCount, 1);
  assert.equal(after.linkedOrderCount, 1);
});
test('same key with different amount cannot silently overwrite order', async () => {
  const k = key();
  const first = await createPurchaseOrder(request(k));
  const before = await orderStats(k);
  await assert.rejects(() => createPurchaseOrder(request(k, 9999)),
    /Idempotency key reused with different payload/);
  const after = await orderStats(k);
  assert.equal(after.allOrderCount, before.allOrderCount);
  assert.equal((await lookupPurchaseOrder(k)).orderId, first.orderId);
});
test('same key with different supplier cannot silently overwrite order', async () => {
  const k = key();
  await createPurchaseOrder(request(k));
  await assert.rejects(() => createPurchaseOrder(request(k, 2300, 'Modified Supplier')),
    /Idempotency key reused with different payload/);
  assert.equal((await lookupPurchaseOrder(k)).supplier, 'Synthetic Supplier');
});
test('simulated lost response: lookup and retry reconcile original committed order', async () => {
  const k = key();
  await createPurchaseOrder(request(k)); // Simulate that the client discards this successful response.
  const stored = await lookupPurchaseOrder(k);
  const repeated = await createPurchaseOrder(request(k));
  assert.equal(repeated.orderId, stored.orderId);
  assert.equal(repeated.replayed, true);
});
test('invalid monetary value leaves neither order nor reservation', async () => {
  const k = key();
  const before = await orderStats(k);
  await assert.rejects(() => createPurchaseOrder(request(k, -1)), /Invalid amount/);
  const after = await orderStats(k);
  assert.equal(after.requestCount, 0);
  assert.equal(after.allOrderCount, before.allOrderCount);
});
test('distinct keys produce independent orders', async () => {
  const first = await createPurchaseOrder(request(key()));
  const second = await createPurchaseOrder(request(key()));
  assert.notEqual(first.orderId, second.orderId);
});

function contract() {
  return {
    name: 'purchase-order.create',
    effect: 'write',
    validate: input => input && typeof input.supplier === 'string'
      && Number.isSafeInteger(input.amountMinor) && input.amountMinor > 0,
    policy: (_, context) => context.roles.includes('buyer')
      ? { kind: 'allow' } : { kind: 'deny', reason: 'Buyer role required' },
    execute: (input, context) => createPurchaseOrder({
      requestKey: context.idempotencyKey,
      supplier: input.supplier,
      amountMinor: input.amountMinor,
    }),
    verify: async (input, output, context) => {
      const stored = await lookupPurchaseOrder(context.idempotencyKey);
      return stored?.orderId === output.orderId
        && stored?.supplier === input.supplier
        && stored?.amountMinor === String(input.amountMinor);
    },
  };
}
function averactAdapters() {
  const receipts = [];
  return {
    receipts,
    audit: { async record() {} },
    receiptsSink: { async record(receipt) { receipts.push(receipt); } },
  };
}
test('Averact runner + real PostgreSQL replay returns consistent receipts', async () => {
  const k = key();
  const a = averactAdapters();
  const adapters = { audit: a.audit, receipts: a.receiptsSink };
  const input = { supplier: 'Synthetic Supplier', amountMinor: 7600 };
  const run = () => runActionWithReceipt(contract(), {
    input, context: { actorId: 'synthetic-buyer', roles: ['buyer'] },
    idempotencyKey: k,
  }, adapters);
  const first = await run();
  const second = await run();
  assert.equal(first.result.status, 'completed');
  assert.equal(second.result.status, 'completed');
  assert.equal(first.result.output.orderId, second.result.output.orderId);
  assert.equal(second.result.output.replayed, true);
  assert.equal(await verifyActionReceipt(first.receipt, input), true);
  assert.equal(a.receipts.length, 2);
  assert.equal((await orderStats(k)).linkedOrderCount, 1);
});
test('Averact runner treats key-reuse conflict as uncertain execution error', async () => {
  const k = key();
  const adapters = { audit: { async record() {} }, receipts: { async record() {} } };
  const action = amountMinor => runActionWithReceipt(contract(), {
    input: { supplier: 'Synthetic Supplier', amountMinor },
    context: { actorId: 'synthetic-buyer', roles: ['buyer'] },
    idempotencyKey: k,
  }, adapters);
  const first = await action(100);
  await assert.rejects(() => action(200),
    error => error instanceof AveractError && error.phase === 'execution'
      && error.mayHaveExecuted === true);
  assert.equal((await lookupPurchaseOrder(k)).orderId, first.result.output.orderId);
});
