# Action Receipts (experimental)

`runActionWithReceipt` is an **opt-in wrapper** for `runAction`. The original API remains unchanged. Each terminal result includes a receipt with a deterministic checksum and an input fingerprint. Runtime exceptions after an operation ID has been allocated can also yield an error receipt via the sink.

```js
import { runActionWithReceipt, verifyActionReceipt } from '../dist/index.js';
const { result, receipt } = await runActionWithReceipt(contract, request, {
  audit: durableAuditSink,
  approvals: trustedApprovalService, // optional
  receipts: durableReceiptSink,     // optional
});
const internallyConsistent = await verifyActionReceipt(receipt, request.input);
```

## Threat model and scope

- **NOT cryptographic authentication:** SHA-256 checks whether fields were modified without recomputing the checksum. Anybody may alter fields *and recompute* the checksum. Do not call this a signed, authentic, nonrepudiable, or tamper-proof receipt.
- **NOT a privacy guarantee:** hashes of predictable inputs may be guessed via dictionary attacks. This format contains operation identifiers, action names, timestamps, and optional approval references; treat them as potentially sensitive metadata.
- **NOT proof of correct execution:** verification calls trusted host code; this format cannot independently establish downstream business correctness.
- **NOT durable by default:** without `receipts.record`, the receipt exists only in memory. Hosts must manage persistence, access control, retention, and integrity protections.
- **NOT a transactional outbox:** the execution and receipt write are not atomic. A failed receipt write after execution raises `AveractError` with `phase='receipt'` and `mayHaveExecuted=true`.
- **NOT exactly-once processing:** downstream authorization and idempotency are essential.

## Deterministic input handling

Receipt inputs must be plain JSON values. Key order is sorted recursively. Cycles, `Date`, getters, hidden object fields, symbols, nonfinite numbers, and overly complex objects are rejected **before calling the runtime**. The accepted value is cloned and deeply frozen, ensuring the fingerprint corresponds to the object passed to policy and execution. This is a constrained local format, *not* RFC 8785. Do not use the current format for financial-grade canonicalization: JavaScript numbers alone are insufficient for exact money representation.

## Approval evidence

A host-managed approval service may return either a boolean or `{ approved: true, reference: 'APP-123' }`. The reference is opaque and unverified by Averact; host code must bind the approval to identity, input, expiry, and permission. A plain `true` is preserved for compatibility but provides no evidence reference.

## Error paths

`AveractError.operationId` correlates failures to receipts when runtime execution begins; failures during *pre-runtime* input canonicalization cannot produce a receipt because no trusted input fingerprint or operation ID was established. Use a host-level rejected-input audit for those cases.

This is intentionally a first iteration. A future signed receipt format requires an RFC, key management, replay resistance, and threat-model review.
