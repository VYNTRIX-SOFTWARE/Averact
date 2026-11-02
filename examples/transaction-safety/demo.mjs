import { randomUUID } from 'node:crypto';
import { runActionWithReceipt, verifyActionReceipt } from '../../dist/index.js';
import { initializeDemo, createPurchaseOrder, lookupPurchaseOrder } from './db.mjs';

const requestKey = 'demo-' + randomUUID();
const input = { supplier: 'Synthetic Supplier', amountMinor: 250000 };
const contract = {
  name: 'purchase-order.create',
  effect: 'write',
  validate: data => data !== null && typeof data === 'object'
    && typeof data.supplier === 'string' && data.supplier.length > 0
    && Number.isSafeInteger(data.amountMinor) && data.amountMinor > 0,
  policy: (_, context) => context.roles.includes('buyer')
    ? { kind: 'allow' } : { kind: 'deny', reason: 'Buyer role required' },
  execute: (data, context) => createPurchaseOrder({
    requestKey: context.idempotencyKey,
    supplier: data.supplier,
    amountMinor: data.amountMinor,
  }),
  verify: async (data, result, context) => {
    const record = await lookupPurchaseOrder(context.idempotencyKey);
    return record !== null && record.orderId === result.orderId
      && record.supplier === data.supplier && record.amountMinor === String(data.amountMinor);
  },
};
const context = { actorId: 'synthetic-operator', roles: ['buyer'] };
const events = [];
const receipts = [];
const adapters = {
  // In-memory only: production requires authenticated and durable adapters.
  audit: { async record(event) { events.push(event); } },
  receipts: { async record(receipt) { receipts.push(receipt); } },
};
await initializeDemo();
const first = await runActionWithReceipt(contract,
  { input, context, idempotencyKey: requestKey }, adapters);
const replay = await runActionWithReceipt(contract,
  { input, context, idempotencyKey: requestKey }, adapters);
console.log(JSON.stringify({
  firstStatus: first.result.status,
  firstOrderId: first.result.output?.orderId,
  secondStatus: replay.result.status,
  secondOrderId: replay.result.output?.orderId,
  replayed: replay.result.output?.replayed,
  sameOrder: first.result.output?.orderId === replay.result.output?.orderId,
  receiptConsistent: await verifyActionReceipt(first.receipt, input),
  auditEvents: events.length,
  receipts: receipts.length,
}, null, 2));
