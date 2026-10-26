import test from 'node:test';
import assert from 'node:assert/strict';
import { AveractError, fingerprintActionInput, runActionWithReceipt, verifyActionReceipt } from '../dist/index.js';

const actor = { actorId: 'synthetic-buyer', roles: ['buyer'] };
function fixture(overrides = {}) {
  const writes = [], receipts = [], events = [];
  const contract = {
    name: 'purchase-order.create', effect: 'write',
    validate: x => x && Number.isSafeInteger(x.amount) && x.amount > 0,
    policy: input => input.amount > 10000 ? {kind:'deny',reason:'budget'} : input.amount > 5000 ? {kind:'approval_required',reason:'manager'} : {kind:'allow'},
    async execute(input) { writes.push(input); return { amount:input.amount }; },
    verify: (input,output) => input.amount === output.amount,
    ...overrides.contract,
  };
  const adapters = {
    audit:{async record(event){events.push(event);}},
    receipts:{async record(receipt){receipts.push(receipt);}},
    ...overrides.adapters,
  };
  const req = (input={amount:2500}) => ({input,context:actor,idempotencyKey:'order-intent-001'});
  return {contract,adapters,req,writes,receipts,events};
}
test('completed receipt is consistent, correlated, and excludes raw data',async()=>{
  const x=fixture();
  const {result,receipt}=await runActionWithReceipt(x.contract,x.req(),x.adapters);
  assert.equal(result.status,'completed');
  assert.equal(receipt.policy,'allow');
  assert.equal(receipt.verification,'passed');
  assert.equal(receipt.operationId,result.operationId);
  assert.equal(receipt.operationId,x.events[0].operationId);
  assert.equal(await verifyActionReceipt(receipt,{amount:2500}),true);
  assert.equal(x.receipts.length,1);
  assert.equal(JSON.stringify(receipt).includes('order-intent-001'),false);
});
test('canonical fingerprint ignores object insertion order',async()=>{
  assert.equal(await fingerprintActionInput({a:1,b:[{y:2,x:3}]}),await fingerprintActionInput({b:[{x:3,y:2}],a:1}));
});
test('tamper or wrong expected input fails consistency verification',async()=>{
  const x=fixture();const {receipt}=await runActionWithReceipt(x.contract,x.req(),x.adapters);
  assert.equal(await verifyActionReceipt({...receipt,outcome:'denied'}),false);
  assert.equal(await verifyActionReceipt(receipt,{amount:999}),false);
});
test('denied and approval-required actions never execute',async()=>{
  const x=fixture();const denied=await runActionWithReceipt(x.contract,x.req({amount:12000}),x.adapters);
  const pending=await runActionWithReceipt(x.contract,x.req({amount:7000}),x.adapters);
  assert.equal(denied.receipt.policy,'deny');
  assert.equal(denied.receipt.mayHaveExecuted,false);
  assert.equal(pending.receipt.approval,'not_configured');
  assert.equal(x.writes.length,0);
});
test('trusted structured approval creates opaque evidence reference',async()=>{
  const x=fixture({adapters:{approvals:{async check(){return {approved:true,reference:'APP-7'};}}}});
  const {receipt}=await runActionWithReceipt(x.contract,x.req({amount:7000}),x.adapters);
  assert.equal(receipt.approval,'approved');
  assert.equal(receipt.approvalReference,'APP-7');
  assert.equal(x.writes.length,1);
});
test('truthy non-boolean approvals never authorize',async()=>{
  const x=fixture({adapters:{approvals:{async check(){return {approved:'yes',reference:'fake'};}}}});
  const {receipt}=await runActionWithReceipt(x.contract,x.req({amount:7000}),x.adapters);
  assert.equal(receipt.approval,'rejected');
  assert.equal(x.writes.length,0);
});
test('invalid trusted approval reference fails closed',async()=>{
  const x=fixture({adapters:{approvals:{async check(){return {approved:true,reference:''};}}}});
  await assert.rejects(()=>runActionWithReceipt(x.contract,x.req({amount:7000}),x.adapters),e=>e instanceof AveractError && e.phase==='approval' && !e.mayHaveExecuted);
  assert.equal(x.receipts[0].errorPhase,'approval');
  assert.equal(x.writes.length,0);
});
test('verification failure does not misrepresent success',async()=>{
  const x=fixture({contract:{verify:()=>false}});
  const {receipt}=await runActionWithReceipt(x.contract,x.req(),x.adapters);
  assert.equal(receipt.verification,'failed');
  assert.equal(receipt.outcome,'verification_failed');
  assert.equal(receipt.mayHaveExecuted,true);
});
test('execution exception creates error receipt with same operation ID',async()=>{
  const x=fixture({contract:{async execute(){throw Error('timeout');}}});
  await assert.rejects(()=>runActionWithReceipt(x.contract,x.req(),x.adapters),e=>e instanceof AveractError && e.phase==='execution' && e.operationId===x.receipts[0].operationId);
  assert.equal(x.receipts[0].outcome,'error');
  assert.equal(x.receipts[0].mayHaveExecuted,true);
});
test('receipt storage failure after execution is an uncertain error',async()=>{
  const x=fixture({adapters:{receipts:{async record(){throw Error('storage offline');}}}});
  await assert.rejects(()=>runActionWithReceipt(x.contract,x.req(),x.adapters),e=>e instanceof AveractError && e.phase==='receipt' && e.mayHaveExecuted);
  assert.equal(x.writes.length,1);
});
test('input snapshot cannot be changed by caller midway',async()=>{
  const input={amount:2500,nested:{note:'original'}};
  const x=fixture({contract:{policy:i=>{input.amount=9999;input.nested.note='tampered';assert.equal(Object.isFrozen(i.nested),true);return {kind:'allow'};}}});
  const {receipt}=await runActionWithReceipt(x.contract,x.req(input),x.adapters);
  assert.equal(x.writes[0].amount,2500);
  assert.equal(await verifyActionReceipt(receipt,{amount:2500,nested:{note:'original'}}),true);
});
test('reject cycles, nonfinite values, and getters before side effects',async()=>{
  const x=fixture();const cyc={amount:1};cyc.self=cyc;
  const getter={amount:1};Object.defineProperty(getter,'secret',{enumerable:true,get(){throw Error('accessed');}});
  for(const payload of [cyc,{amount:Infinity},{amount:1,time:new Date()},getter]) {
    await assert.rejects(()=>runActionWithReceipt(x.contract,x.req(payload),x.adapters),TypeError);
  }
  assert.equal(x.writes.length,0);
});
