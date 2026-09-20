# DALgo for ClickHouse HTTP

`@dal-go/dalgo2clickhouse` maps a top-level DALgo collection to a ClickHouse table through ClickHouse's reusable HTTP interface. It is deliberately a **read/query adapter with explicit append-only ingestion**, not a pretend OLTP abstraction. The configured key column is a unique ClickHouse `String` column; it identifies the DALgo record but is removed from decoded record data.

## Status and safety

This adapter is **HTTP-capable**, not browser-ready by default. ClickHouse's official web client is intended for current browsers, but an operator must deliberately configure CORS response headers and expose a narrowly scoped HTTPS endpoint. The default `/ping` endpoint does not support CORS. Do not put a long-lived ClickHouse password, basic-auth credential, or broad API key in browser code. Prefer a trusted backend that exchanges user identity for a short-lived, table- and operation-scoped token.

The adapter uses `fetch`, HTTPS (except loopback development), POST request bodies for SQL, typed ClickHouse `{name:Type}` parameters using ClickHouse's Escaped wire syntax, redirects disabled, a timeout, bounded result sets and response bytes, strict JSON response checks, and errors that omit SQL, parameter values, response bodies, URLs, and credentials. Parameter values necessarily travel as ClickHouse `param_*` HTTP parameters; treat filter values as potentially visible to endpoint/proxy logs and avoid putting secrets in queries.

Supported:

- top-level point reads when the configured `idColumn` is a unique `String` column;
- top-level structured queries with scalar comparison/membership filters, ordering, offset/limit, and exclusive `startAfter` keyset pagination;
- codecs for row data;
- `append(collection, values)`, an explicit JSONEachRow event-ingest helper.

Explicit limitations:

- `ClickHouseDatabase` intentionally does **not** implement DALgo `WriteSession`. `insert`, `set`, `update`, and `delete` would imply unique-key/replace/partial-update/delete guarantees that ordinary ClickHouse MergeTree-family tables do not provide. Mutations are asynchronous and engine-specific; duplicate/replacing/versioned behavior is table-schema-specific.
- DALgo callback transactions are rejected. HTTP sessions serialize requests but are not DALgo atomic read/write transactions.
- `append` is only append-only ingestion. Retrying it can write duplicate events; configure idempotency/deduplication in the ClickHouse table or upstream pipeline.
- Nested keys and collection-group queries are rejected. Table/field/database identifiers must be conservative ASCII identifiers, so user values cannot become SQL syntax.
- `array-contains`, `array-contains-any`, inclusive/end cursors, null cursors, and `startAfter` combined with offset are rejected. `startAfter` needs an explicit order and includes the configured key column as an ascending tie-breaker when absent.
- A cursor is reliable only when the declared order plus key establishes a stable total order, and it inherits ClickHouse's snapshot/merge/eventual visibility behavior. Queries without `ORDER BY` have no order guarantee or cursor.
- Numeric DALgo key IDs are rejected. ClickHouse JSON may quote 64-bit integer values, so accepting numeric keys would make a query result type-incompatible with a later point read. Use a `String` `idColumn` and string DALgo IDs.
- JSON wire formats may render large non-key integers as strings. The adapter preserves the wire representation rather than silently losing precision.
- Browser use additionally needs CORS preflight/header policy for `POST`, `Authorization`, and `Content-Type`; a public general SQL endpoint is normally unsafe. Use row policies, query complexity/resource limits, and least-privilege ClickHouse roles even behind a backend.

## Install

```bash
pnpm add @dal-go/dalgo github:dal-go/dalgo2clickhouse-js
```

When installing unreleased Git revisions with pnpm's dependency build policy, authorize only the exact reviewed DALgo and adapter revisions in your workspace's `allowBuilds` configuration. Do not enable dependency scripts globally.

## Example

```ts
import { collection } from "@dal-go/dalgo";
import { ClickHouseDatabase } from "@dal-go/dalgo2clickhouse";

const events = collection<{ kind: string; occurredAt: string }>("events");
const db = new ClickHouseDatabase({
  baseUrl: "https://your-service.clickhouse.cloud:8443",
  database: "analytics",
  headers: async () => ({ Authorization: `Bearer ${await obtainShortLivedToken()}` }),
});

const page = await db.query(events.query().where("kind", "==", "signup").orderBy("occurredAt", "desc").limit(50).build());
await db.append("events", [{ id: "evt-1", kind: "signup", occurredAt: new Date().toISOString() }]);
```

See [`examples/basic.ts`](examples/basic.ts). Tests use an injected `fetch`; no live ClickHouse service, browser, token, or CORS deployment was exercised.

## Official API references

- [ClickHouse HTTP interface](https://clickhouse.com/docs/concepts/features/interfaces/http)
- [ClickHouse JavaScript client (web support and limitations)](https://clickhouse.com/docs/integrations/language-clients/js/index)
- [ClickHouse query parameters](https://clickhouse.com/docs/concepts/features/interfaces/http#querying-over-httphttps)
- [ClickHouse HTTP response headers and CORS policy configuration](https://clickhouse.com/docs/concepts/features/interfaces/http#http-response-headers)
