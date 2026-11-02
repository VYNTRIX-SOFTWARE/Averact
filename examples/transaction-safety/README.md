# PostgreSQL Transaction Safety Demo

A **standalone**, synthetic PostgreSQL 16 example showing how an application can implement atomic idempotency behind Averact's execution callback. The Averact core has no PostgreSQL dependency. This demo calls the system `psql` executable from Node.js; it does not need an npm PostgreSQL driver.

## Run locally

Requires Node.js 22+, npm, Docker Compose, and the `psql` CLI.

```sh
npm ci
docker compose -f examples/transaction-safety/compose.yaml up -d --wait
export PGHOST=127.0.0.1 PGPORT=55432 PGUSER=averact_demo PGPASSWORD=local_demo_only PGDATABASE=averact_demo
npm run test:integration
npm run example:postgres
docker compose -f examples/transaction-safety/compose.yaml down
```

The localhost-only password is **demo-only**. Never reuse this configuration on a real database.

## Why this prevents duplicate orders

The `action_requests.request_key` primary key arbitrates concurrent requests; PostgreSQL blocks contenders until the winning transaction commits/rolls back. Within the same function call and transaction, the winner creates one purchase order and links it to the request row. A matching replay returns the existing order ID; a changed payload with the same key is rejected.

This guarantee depends on the database enforcing a unique constraint, an atomic transaction, and the selected **READ COMMITTED** isolation. It is not provided by the Averact SDK, the in-memory receipt sink, or an AI model.

Amounts are represented in integer minor units, not floating point. Demo validates only positive BIGINT amounts and synthetic supplier strings.

## Covered integration scenarios

- First write and consistent lookup
- Sequential and 16-way concurrent replay
- Changed amount/supplier with reused key rejected
- Reconciliation after lost successful client response
- Invalid amount does not reserve a key or create a row
- Separate keys get separate orders
- Averact runner + receipt integration against real PostgreSQL
- Reuse conflict surfaces as an uncertain outcome through AveractError

## Known limitations

- Single-tenant demo; real systems must namespace keys by authenticated tenant, actor, and action semantics, and enforce permission on every write.
- No approval persistence, transactional outbox, WAL tracking, audit durability, or business-ledger model.
- PostgreSQL isolation other than READ COMMITTED is **not tested**; serializable/repeatable-read may need transaction-level retry with careful reconciliation.
- No key TTL, expiration, encryption, operational monitoring, schema upgrade strategy, or HA.
- Hashes and receipts are not cryptographically authenticated.
- Lost response is **simulated** by discarding a successful client response; it does not inject an actual network fault.
- Client logs may include input in error messages; keep credentials and sensitive data out of logs.
- Do not use this prototype directly for regulated or production financial transactions.
