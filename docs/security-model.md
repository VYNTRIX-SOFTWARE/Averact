# Security model — experimental alpha

**Averact is not a security boundary or a production governance platform.**

## Trust boundaries

- Agent input is untrusted and must be validated.
- The host must construct `TrustedContext` from authenticated, server-side identity. Never accept roles, actor identity, or approval flags asserted by an agent.
- Contracts and adapters are trusted host code; do not execute agent-generated policies.
- Downstream systems must independently enforce authorization and business invariants at commit time, mitigating time-of-check/time-of-use races.
- Approval adapters MUST verify the authenticated approver, scope, payload/operation binding, expiry, revocation, and durable record. A boolean-returning demo adapter by itself is not human approval.

## Writes and retries

- A write requires an idempotency key, but Averact **does not perform deduplication**. The downstream system must enforce atomic, persistent idempotency even under concurrency.
- Every call gets a new operation ID; it is not a durable transaction reference.
- Verification failures, exceptions, and post-execution audit failures may occur after the external action commits. `AveractError.mayHaveExecuted` warns callers not to blindly retry. Errors also carry an `operationId` for audit correlation. This is not a stable transaction identifier across retries.
- The runner never automatically retries actions; callers must reconcile outcomes against downstream records and use the same trusted, backend-enforced idempotency key before any retry.
- A verifier is only as trustworthy as the evidence it checks.

## Audit

- The audit adapter MUST persist records before returning.
- A failing `execution_started` audit prevents execution. Later audit failures cannot undo already committed actions.
- Raw action input and output are not included automatically. `reason` is policy-authored and must not contain credentials, customer information, or sensitive data. Actor identifiers still need proper retention controls.
- Production deployments require durable, access-controlled, tamper-evident audit sinks.

## Experimental action receipts

Receipts are not signatures or independent evidence of correct execution. Their unkeyed checksums can be re-computed by an attacker; input hashes do not guarantee privacy. The host must provide protected durable storage, authenticated approval evidence and downstream reconciliation. See [action receipts](action-receipts.md).

## Not included

No identity provider, approval database, durable orchestrator, transactional outbox, distributed locks, exactly-once guarantee, MCP bridge, sandbox, policy language, or regulatory certification.
