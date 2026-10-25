# Contributing to Averact

We welcome focused, useful contributions from developers of all experience levels.

## Local setup

Use Node.js 20+ and npm:

```sh
npm install
npm run typecheck
npm test
npm run example
```

The demo is synthetic and does not require external infrastructure.

## Pull request guidance

1. Open a discussion issue for changes to the public API or security model.
2. Keep PRs focused and explain a concrete developer problem.
3. Add tests for both expected behavior and security/retry failure cases.
4. Update documentation when behavior or guarantees change.
5. Never submit confidential company source, private customer workflows, personal data, credentials, or proprietary datasets.

Good first contributions: edge-case tests, documentation, error messages, synthetic examples, and clearer contract semantics.

By submitting code, you license your contribution under Apache-2.0 and confirm you have the rights to contribute it.
