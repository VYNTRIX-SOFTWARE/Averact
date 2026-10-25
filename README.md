# averact

**Autonomy, with accountability.**

*Action contracts for agent-initiated operations.*

[![CI](https://github.com/VYNTRIX-SOFTWARE/Averact/actions/workflows/ci.yml/badge.svg)](https://github.com/VYNTRIX-SOFTWARE/Averact/actions/workflows/ci.yml)
[![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
![Experimental](https://img.shields.io/badge/status-experimental-orange)

An open-source project created and maintained by **[VYNTRIX](https://github.com/VYNTRIX-SOFTWARE)**.

> **Experimental alpha. Not production hardened.** Averact is not a complete authorization boundary. It does not provide identity, durable approvals, transactionally enforced idempotency, or compliance certification. See [Security](docs/security-model.md).

## The problem

AI agents increasingly initiate actions, not just generate text. Each action needs an explicit answer to four questions: **Is the input valid? Is the actor authorized? Is approval necessary? Did the intended outcome actually occur?**

Averact is a minimal, framework-independent TypeScript experiment for attaching action contracts to trusted application code. It is **not** an AI agent, MCP server, database, or workflow engine.

**Execution path:** validate → policy → optional approval check → audit → execute → verify → audit.

## Features implemented

- Typed action contracts with runtime validation
- Allow, deny, and approval-required policy outcomes
- Trusted approval-adapter hook (no built-in approvals storage)
- Audit sink hook with pre-execution fail-closed behavior
- Post-execution verification and explicit uncertain-outcome errors
- Mandatory idempotency *keys* for write actions (enforcement belongs to the downstream system)

## Try the prototype

Requires Node.js 20+ and npm; no database or AI API key is necessary.

```sh
git clone https://github.com/VYNTRIX-SOFTWARE/Averact.git
cd Averact
npm install
npm test
npm run example
```

The synthetic purchase-order example demonstrates:
- IDR 2,500,000 → completed
- IDR 6,000,000 → approval required; not executed
- IDR 12,000,000 → denied by policy

Read [examples/purchase-order.mjs](examples/purchase-order.mjs) to see the full runnable integration.

## Minimal API shape

```ts
import { runAction, type ActionContract } from '@averact/core';

const contract: ActionContract<Input, Output> = {
  name: 'purchase-order.create',
  effect: 'write',
  validate: isValidOrderInput,
  policy: evaluateBusinessPolicy,
  execute: sendToTrustedBackend,
  verify: verifyDownstreamOrder,
};

const result = await runAction(contract, {
  input: proposedOrder,                  // untrusted
  context: authenticatedServerContext,  // trusted; never agent-provided
  idempotencyKey: 'order-intent-123',
}, {
  audit: durableAuditAdapter,
  approvals: trustedApprovalAdapter,
});
```

This is an **API sketch**: the named callbacks and adapters are supplied by the host application; no package has been published yet. Import from local build output in the runnable example.

## Project documentation

[Architecture](docs/architecture.md) · [Security model](docs/security-model.md) · [Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md) · [Security reports](SECURITY.md)

## Contributing

Issues, tests, documentation, and small improvements are welcome. Please follow [CONTRIBUTING.md](CONTRIBUTING.md). Do not submit customer data or proprietary company code.

## License

Apache-2.0. See [LICENSE](LICENSE). The source license does not grant rights to the Averact or VYNTRIX trademarks.
