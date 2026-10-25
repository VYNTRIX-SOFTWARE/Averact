# Architecture

```text
Untrusted agent / caller
           |
           v
Host integration constructs trusted identity
           |
           v
Validate -> Policy -> Approval adapter -> Audit -> Execute -> Verify
                                 |                    |
                       trusted external service   downstream API
                                              (owns transaction, auth and idempotency)
```

The TypeScript `runAction` function takes a trusted application-defined contract, untrusted input, a server-authenticated context, and host adapters.

- **Validation** checks proposed input.
- **Policy** decides allow, deny, or approval required.
- **Approval adapter** calls host-managed authorization; there is no stored approval state in Averact.
- **Audit** records decisions and the execution boundary. A failed pre-execution audit blocks execution.
- **Execution** calls application-owned code.
- **Verification** checks the downstream result; a false return is not a rollback.

See the [security model](security-model.md). There are no MCP adapters, distributed workflows, or durable state in alpha.
