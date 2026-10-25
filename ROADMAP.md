# Roadmap

These are proposals, not release commitments.

## v0.1 alpha — merged

- [x] Typed action contracts, validation, and explicit policy outcomes
- [x] Approval-adapter hook, execution, verification, and audit hooks
- [x] Side-effect uncertainty errors
- [x] Synthetic purchase-order example and unit tests
- [ ] Public API review and package publishing strategy
- [x] Reproducible dependency lockfile and locked CI installation (PR #2)
- [ ] Release automation and package publishing strategy

## Reliability milestone — PR #2

- [x] Node.js 22/24 CI matrix with `npm ci`
- [x] Expanded failure-path regression tests and audit correlation IDs
- [x] Documentation of retry uncertainty and downstream idempotency requirements

## v0.2 — candidate priorities

- [ ] Durable approval binding reference integration
- [ ] Simulated transactional backend enforcing atomic idempotency
- [ ] Structured errors and conformance fixtures
- [ ] Concurrency/race-condition tests

## Later — subject to community RFCs

- [ ] MCP integration adapter
- [ ] Python SDK
- [ ] Local contract testing CLI and visual inspector
- [ ] Policy interoperability specification

We prioritize credible guarantees over a broad feature list.
