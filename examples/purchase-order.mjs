import { runAction } from '../dist/index.js';

// All sample data are synthetic; no production purchasing system is contacted.
const orders = [];
const contract = {
  name: 'purchase-order.create',
  effect: 'write',
  validate: input => input !== null && typeof input === 'object'
    && typeof input.supplier === 'string' && input.supplier.length > 0
    && Number.isSafeInteger(input.amountIdr) && input.amountIdr > 0,
  policy(input, context) {
    if (!context.roles.includes('buyer')) return { kind: 'deny', reason: 'Buyer role required' };
    if (input.amountIdr > 10_000_000) return { kind: 'deny', reason: 'Budget exceeded' };
    if (input.amountIdr > 5_000_000) return { kind: 'approval_required', reason: 'Manager needed' };
    return { kind: 'allow' };
  },
  async execute(input, ctx) {
    // Demo only: a real backend MUST enforce permissions and idempotency atomically.
    const order = { id: `DEMO-${orders.length + 1}`, ...input, requestKey: ctx.idempotencyKey };
    orders.push(order);
    return order;
  },
  verify: (input, output) => input.supplier === output.supplier && input.amountIdr === output.amountIdr,
};
const adapters = {
  audit: { async record(event) { console.log(`[audit] ${event.type}: ${event.actionName}`); } },
};
const context = { actorId: 'synthetic-buyer', roles: ['buyer'] };
for (const [key, amountIdr] of [['order-001', 2_500_000], ['order-002', 6_000_000], ['order-003', 12_000_000]]) {
  const result = await runAction(contract, {
    input: { supplier: 'Synthetic Supplier', amountIdr }, context, idempotencyKey: key,
  }, adapters);
  console.log({ amountIdr, status: result.status, operationId: result.operationId });
}
