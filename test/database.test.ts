import { UnsupportedError, collection, key } from "@dal-go/dalgo";
import { describe, expect, it, vi } from "vitest";
import { ClickHouseDatabase, ClickHouseHttpError } from "../src/index.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("ClickHouseDatabase", () => {
  it("gets existing, missing, and duplicate-key rows with parameterized POST requests", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ data: [{ id: "a", score: 3 }] }))
      .mockResolvedValueOnce(json({ data: [] }))
      .mockResolvedValueOnce(json({ data: [{ id: "a" }, { id: "a" }] }));
    const db = new ClickHouseDatabase({ baseUrl: "https://click.example", database: "analytics", fetch });
    await expect(db.get(key("events", "a"))).resolves.toMatchObject({ key: key("events", "a"), exists: true, data: { score: 3 } });
    await expect(db.get(key("events", "missing"))).resolves.toEqual({ key: key("events", "missing"), exists: false });
    await expect(db.get(key("events", "a"))).rejects.toThrow("idColumn is unique");
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://click.example/?database=analytics&wait_end_of_query=1&param_id=a");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.body).toBe("SELECT * FROM `analytics`.`events` AS t WHERE t.`id` = {id:String} LIMIT 2 FORMAT JSON");
  });

  it("preserves getMany ordering and uses a codec for data but not the key", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ data: [{ id: "a", wire: 1 }] }))
      .mockResolvedValueOnce(json({ data: [] }));
    const db = new ClickHouseDatabase({ baseUrl: "https://click.example", fetch });
    const rows = await db.getMany([key("events", "a"), key("events", "b")], {
      encode: vi.fn(), decode: (value) => ({ decoded: value }),
    });
    expect(rows).toEqual([
      { key: key("events", "a"), exists: true, data: { decoded: { wire: 1 } } },
      { key: key("events", "b"), exists: false },
    ]);
  });

  it("executes bounded structured queries and returns a usable keyset cursor", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ data: [{ id: "a", score: 4 }, { id: "b", score: 5 }] }));
    const db = new ClickHouseDatabase({ baseUrl: "https://click.example", maxResults: 2, fetch });
    const result = await db.query(collection<{ id: string; score: number }>("events").query().orderBy("score").limit(2).build());
    expect(result.records).toEqual([
      { key: key("events", "a"), exists: true, data: { score: 4 } },
      { key: key("events", "b"), exists: true, data: { score: 5 } },
    ]);
    expect(result.nextCursor).toEqual({ values: [5, "b"] });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", method: "POST" });
  });

  it("enforces string keys and keeps mandatory JSON headers ahead of configured values", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ data: [] }));
    const db = new ClickHouseDatabase({
      baseUrl: "https://click.example",
      headers: { accept: "text/plain", "content-type": "application/x-secret", Authorization: "Bearer secret" },
      fetch,
    });
    await expect(db.get(key("events", 42))).rejects.toThrow("only string DALgo keys");
    await db.get(key("events", "safe"));
    const request = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toMatchObject({
      accept: "application/json",
      "content-type": "text/plain; charset=utf-8",
      Authorization: "Bearer secret",
    });
    const specialFetch = vi.fn().mockResolvedValue(json({ data: [] }));
    const special = new ClickHouseDatabase({ baseUrl: "https://click.example", fetch: specialFetch });
    await special.get(key("events", "a\n'\\b"));
    const url = new URL(specialFetch.mock.calls[0]?.[0] as string);
    expect(url.searchParams.get("param_id")).toBe("a\\n\\'\\\\b");
  });

  it("supports only explicit append-only event ingestion, not DALgo CRUD", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    const db = new ClickHouseDatabase({ baseUrl: "https://click.example", fetch });
    await db.append("events", [{ id: "a", score: 1 }, { id: "b", score: 2 }]);
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe('INSERT INTO `events` FORMAT JSONEachRow\n{"id":"a","score":1}\n{"id":"b","score":2}');
    expect(fetch.mock.calls[0]?.[0]).not.toContain("score");
    await expect(db.runReadwriteTransaction(() => Promise.resolve("never"))).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.append("events", [{ unsafe: true }], {
      encode: () => "not-a-row",
      decode: (value) => value as { readonly unsafe: boolean },
    })).rejects.toThrow("JSONEachRow");
  });

  it("does not make a request for invalid configuration, unsafe tables, limits, or nested keys", async () => {
    expect(() => new ClickHouseDatabase({ baseUrl: "http://click.example" })).toThrow("HTTPS");
    expect(() => new ClickHouseDatabase({ baseUrl: "https://user:secret@click.example" })).toThrow("credentials");
    const fetch = vi.fn();
    const db = new ClickHouseDatabase({ baseUrl: "http://localhost:8123", maxResults: 2, fetch });
    await expect(db.get(key("events;drop", "a"))).rejects.toThrow("simple ClickHouse identifier");
    await expect(db.get(key("parents", "p").child("events", "a"))).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.query(collection("events").query().limit(3).build())).rejects.toThrow("between 1 and 2");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed/network/HTTP responses without retaining server body or credentials", async () => {
    const malformed = new ClickHouseDatabase({ baseUrl: "https://click.example", fetch: vi.fn().mockResolvedValue(json({ data: "wrong" })) });
    await expect(malformed.get(key("events", "a"))).rejects.toThrow("malformed ClickHouse get response");
    const failed = new ClickHouseDatabase({
      baseUrl: "https://click.example",
      headers: { Authorization: "Bearer secret" },
      fetch: vi.fn().mockResolvedValue(new Response("detail-secret", { status: 500 })),
    });
    const error = await failed.get(key("events", "a")).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClickHouseHttpError);
    expect(String(error)).not.toContain("secret");
    const offline = new ClickHouseDatabase({ baseUrl: "https://click.example", fetch: vi.fn().mockRejectedValue(new Error("offline")) });
    await expect(offline.get(key("events", "a"))).rejects.toMatchObject({ status: 0 });
  });

  it("rejects response bodies above configured byte caps before parsing", async () => {
    const advertised = new ClickHouseDatabase({
      baseUrl: "https://click.example",
      maxResponseBytes: 10,
      fetch: vi.fn().mockResolvedValue(new Response("{}", { headers: { "content-length": "11" } })),
    });
    await expect(advertised.get(key("events", "a"))).rejects.toThrow("maxResponseBytes (10)");
    const streamed = new ClickHouseDatabase({
      baseUrl: "https://click.example",
      maxResponseBytes: 10,
      fetch: vi.fn().mockResolvedValue(new Response('{"data":[{}]}')),
    });
    await expect(streamed.get(key("events", "a"))).rejects.toThrow("maxResponseBytes (10)");
  });
});
