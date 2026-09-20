import { collection } from "@dal-go/dalgo";
import { ClickHouseDatabase } from "../src/index.js";

const events = collection<{ kind: string; occurredAt: string }>("events");
const accessToken = "obtain a scoped short-lived token from your trusted backend";
const db = new ClickHouseDatabase({
  baseUrl: "https://your-service.clickhouse.cloud:8443",
  database: "analytics",
  headers: () => ({ Authorization: `Bearer ${accessToken}` }),
});

// The table's id column must be unique for point reads. This query itself is bounded.
const page = await db.query(events.query().where("kind", "==", "signup").orderBy("occurredAt", "desc").limit(50).build());
console.log(page.records);

// Explicit event ingestion; it is append-only, not DALgo insert/set/update semantics.
await db.append("events", [{ id: "evt-1", kind: "signup", occurredAt: new Date().toISOString() }]);
