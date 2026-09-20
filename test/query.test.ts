import { DOCUMENT_ID, UnsupportedError, collection } from "@dal-go/dalgo";
import { describe, expect, it } from "vitest";
import { compileClickHouseQuery, quoteIdentifier } from "../src/query.js";

describe("compileClickHouseQuery", () => {
  it("uses validated identifiers, typed parameters, POST-safe SQL, and a stable key tie-breaker", () => {
    const query = collection<{ id: string; score: number; active: boolean }>("events")
      .query()
      .where("score", ">=", 4)
      .where("active", "==", true)
      .orderBy("score", "desc")
      .limit(10)
      .build();
    const compiled = compileClickHouseQuery(query, { database: "analytics", idColumn: "id", rowLimit: 10 });
    expect(compiled.sql).toBe(
      "SELECT * FROM `analytics`.`events` AS t WHERE t.`score` >= {p0:UInt64} AND t.`active` = {p1:Bool} ORDER BY t.`score` DESC, t.`id` ASC LIMIT {limit:UInt64} FORMAT JSON",
    );
    expect(compiled.parameters).toEqual([
      { name: "p0", type: "UInt64", value: "4" },
      { name: "p1", type: "Bool", value: "1" },
      { name: "limit", type: "UInt64", value: "10" },
    ]);
    expect(compiled.cursorColumns).toEqual(["score", "id"]);
  });

  it("uses lexicographic typed keyset pagination and validates cursor shape", () => {
    const source = collection<{ id: string; score: number }>("events");
    const first = compileClickHouseQuery(source.query().orderBy("score").limit(1).build(), {
      idColumn: "id",
      rowLimit: 1,
    });
    const second = compileClickHouseQuery(source.query().orderBy("score").startAfter(4, "a").limit(1).build(), {
      idColumn: "id",
      rowLimit: 1,
    });
    expect(first.sql).toContain("ORDER BY t.`score` ASC, t.`id` ASC");
    expect(second.sql).toContain("((t.`score` > {c0:UInt64}) OR (t.`score` = {c0:UInt64} AND t.`id` > {c1:String}))");
    expect(second.parameters.slice(0, 2)).toEqual([
      { name: "c0", type: "UInt64", value: "4" },
      { name: "c1", type: "String", value: "a" },
    ]);
    expect(() => compileClickHouseQuery(source.query().orderBy("score").startAfter(4).build(), {
      idColumn: "id", rowLimit: 1,
    })).toThrow("tie-breaker");
  });

  it("maps null and membership predicates without interpolating values", () => {
    const query = collection<{ id: string; tag: string; removed: string | null }>("events")
      .query()
      .where("removed", "==", null)
      .where("tag", "not-in", ["a", "b"])
      .limit(2)
      .build();
    const compiled = compileClickHouseQuery(query, { idColumn: "id", rowLimit: 2 });
    expect(compiled.sql).toContain("t.`removed` IS NULL AND t.`tag` IS NOT NULL AND t.`tag` NOT IN {p1:Array(String)}");
    expect(compiled.parameters[0]).toEqual({ name: "p1", type: "Array(String)", value: "['a','b']" });
  });

  it("mirrors ClickHouse Escaped parameter syntax for controls, quotes, backslashes, and scalar arrays", () => {
    const source = collection<{ id: string; value: string }>("events");
    const string = compileClickHouseQuery(source.query().where("value", "==", "a\n\t'\\b").limit(1).build(), {
      idColumn: "id", rowLimit: 1,
    });
    const strings = compileClickHouseQuery(source.query().where("value", "in", ["a\nb", "c'd", "e\\f"]).limit(1).build(), {
      idColumn: "id", rowLimit: 1,
    });
    const booleans = compileClickHouseQuery(source.query().where("value", "in", [true, false]).limit(1).build(), {
      idColumn: "id", rowLimit: 1,
    });
    const numbers = compileClickHouseQuery(source.query().where("value", "in", [1, 2]).limit(1).build(), {
      idColumn: "id", rowLimit: 1,
    });
    expect(string.parameters[0]).toEqual({ name: "p0", type: "String", value: "a\\n\\t\\'\\\\b" });
    expect(strings.parameters[0]).toEqual({ name: "p0", type: "Array(String)", value: "['a\\nb','c\\'d','e\\\\f']" });
    expect(booleans.parameters[0]).toEqual({ name: "p0", type: "Array(Bool)", value: "[TRUE,FALSE]" });
    expect(numbers.parameters[0]).toEqual({ name: "p0", type: "Array(UInt64)", value: "[1,2]" });
  });

  it("rejects SQL-shaped identifiers and unsupported DALgo semantics before request construction", () => {
    expect(() => quoteIdentifier("events; DROP TABLE events", "table")).toThrow("simple ClickHouse identifier");
    const nested = collection("parents").key("p").child("events", "e");
    expect(() => compileClickHouseQuery(collection("events").query().where("tag", "array-contains", "a").build(), {
      idColumn: "id", rowLimit: 1,
    })).toThrow(UnsupportedError);
    expect(() => compileClickHouseQuery(collection("events").in(nested).query().build(), {
      idColumn: "id", rowLimit: 1,
    })).toThrow(UnsupportedError);
    expect(() => compileClickHouseQuery(collection("events").query().orderBy(DOCUMENT_ID).startAt("x").build(), {
      idColumn: "id", rowLimit: 1,
    })).toThrow(UnsupportedError);
  });

  it("keeps all document-ID filters and key tie-breaker cursor positions string-typed", () => {
    const source = collection<{ id: string; score: number }>("events");
    expect(() => compileClickHouseQuery(source.query().where(DOCUMENT_ID, "==", 42).build(), {
      idColumn: "id", rowLimit: 1,
    })).toThrow("string DALgo IDs");
    expect(() => compileClickHouseQuery(source.query().where(DOCUMENT_ID, "in", ["a", 42]).build(), {
      idColumn: "id", rowLimit: 1,
    })).toThrow("string DALgo IDs");
    expect(() => compileClickHouseQuery(source.query().orderBy("score").startAfter(1, 42).build(), {
      idColumn: "id", rowLimit: 1,
    })).toThrow("string DALgo IDs");
  });
});
