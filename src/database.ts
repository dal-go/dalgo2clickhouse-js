import {
  Key,
  UnsupportedError,
  identityCodec,
  type Codec,
  type Database,
  type ExistingRecord,
  type QueryPage,
  type ReadwriteTransaction,
  type RecordSnapshot,
  type StructuredQuery,
} from "@dal-go/dalgo";
import { clickHouseParameter, compileClickHouseQuery, quoteIdentifier, type ClickHouseParameter } from "./query.js";

export type ClickHouseHeaders = Readonly<Record<string, string>> | (() => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>);
export type ClickHouseFetch = typeof fetch;

export interface ClickHouseDatabaseOptions {
  /** HTTPS ClickHouse HTTP endpoint. Plain HTTP is accepted only for loopback development. */
  readonly baseUrl: string;
  /** Optional fixed database. Collection names map to tables in this database. */
  readonly database?: string;
  /** Column used as the DALgo key, defaulting to `id`. It must be unique in each mapped table. */
  readonly idColumn?: string;
  /** Refreshable short-lived auth headers. Do not pass credentials in the URL. */
  readonly headers?: ClickHouseHeaders;
  readonly fetch?: ClickHouseFetch;
  readonly timeoutMs?: number;
  /** Hard maximum returned by each DALgo query, default 1,000. */
  readonly maxResults?: number;
  /** Maximum successful HTTP response body accepted before JSON parsing, default 4 MiB. */
  readonly maxResponseBytes?: number;
}

interface ClickHouseJsonResponse {
  readonly data?: readonly unknown[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identityOr<T>(codec?: Codec<T>): Codec<T> {
  return (codec ?? identityCodec) as Codec<T>;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${label} must be a positive safe integer`);
  return result;
}

function assertTopLevel(key: Key): asserts key is Key<string> {
  if (key.parent !== undefined) throw new UnsupportedError("ClickHouse nested collection keys");
  if (typeof key.id !== "string") throw new TypeError("ClickHouse idColumn supports only string DALgo keys");
}

function keyValue(row: Readonly<Record<string, unknown>>, idColumn: string): string {
  const value = row[idColumn];
  if (typeof value !== "string") {
    throw new TypeError(`ClickHouse idColumn ${idColumn} must produce a string; configure a String ClickHouse column`);
  }
  return value;
}

function recordData(row: Readonly<Record<string, unknown>>, idColumn: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([column]) => column !== idColumn));
}

function asRows(value: unknown, context: string): readonly Record<string, unknown>[] {
  const data = isObject(value) ? (value as ClickHouseJsonResponse).data : undefined;
  if (!Array.isArray(data)) {
    throw new TypeError(`malformed ClickHouse ${context} response`);
  }
  return data.map((row, index) => {
    if (!isObject(row)) throw new TypeError(`malformed ClickHouse ${context} row ${String(index)}`);
    return row;
  });
}

function tableName(collection: string, database: string | undefined): string {
  const table = quoteIdentifier(collection, "ClickHouse collection/table name");
  return database === undefined ? table : `${quoteIdentifier(database, "ClickHouse database name")}.${table}`;
}

function requestUrl(baseUrl: string, parameters: readonly ClickHouseParameter[], database: string | undefined): string {
  const url = new URL(baseUrl);
  if (database !== undefined) url.searchParams.set("database", database);
  // Ask ClickHouse to buffer response headers until execution finishes, avoiding false 200s for late failures.
  url.searchParams.set("wait_end_of_query", "1");
  for (const parameter of parameters) url.searchParams.set(`param_${parameter.name}`, parameter.value);
  return url.toString();
}

async function responseText(response: Response, maximumBytes: number): Promise<string> {
  const advertisedLength = response.headers.get("content-length");
  if (advertisedLength !== null && /^\d+$/u.test(advertisedLength) && Number(advertisedLength) > maximumBytes) {
    throw new RangeError(`ClickHouse response exceeds maxResponseBytes (${String(maximumBytes)})`);
  }
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new RangeError(`ClickHouse response exceeds maxResponseBytes (${String(maximumBytes)})`);
      }
      text += decoder.decode(chunk.value, { stream: true });
      chunk = await reader.read();
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** Intentionally excludes response text, SQL, parameters, URLs, and credentials. */
export class ClickHouseHttpError extends Error {
  public readonly status: number;

  public constructor(status: number) {
    super(`ClickHouse request failed with HTTP ${String(status)}`);
    this.name = "ClickHouseHttpError";
    this.status = status;
  }
}

/**
 * DALgo read/query adapter over ClickHouse's reusable HTTP protocol.
 *
 * It deliberately does not implement DALgo WriteSession: MergeTree-family tables
 * do not provide the unique-key, replace, partial-update, delete, or callback
 * transaction guarantees that DALgo CRUD names imply. `append` is an explicitly
 * append-only ingestion helper for configured event-table semantics.
 */
export class ClickHouseDatabase implements Database {
  readonly #baseUrl: string;
  readonly #database: string | undefined;
  readonly #idColumn: string;
  readonly #headers: ClickHouseHeaders | undefined;
  readonly #fetch: ClickHouseFetch;
  readonly #timeoutMs: number;
  readonly #maxResults: number;
  readonly #maxResponseBytes: number;

  public constructor(options: ClickHouseDatabaseOptions) {
    const url = new URL(options.baseUrl.trim());
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new TypeError("baseUrl must use HTTPS, except for loopback development");
    }
    if (url.username.length > 0 || url.password.length > 0) throw new TypeError("baseUrl must not contain credentials");
    if (url.search.length > 0 || url.hash.length > 0) throw new TypeError("baseUrl must not contain a query or fragment");
    this.#baseUrl = url.toString();
    if (options.database !== undefined) quoteIdentifier(options.database, "ClickHouse database name");
    this.#database = options.database;
    this.#idColumn = options.idColumn ?? "id";
    quoteIdentifier(this.#idColumn, "ClickHouse idColumn");
    this.#headers = options.headers;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = positiveInteger(options.timeoutMs, 30_000, "timeoutMs");
    this.#maxResults = positiveInteger(options.maxResults, 1_000, "maxResults");
    this.#maxResponseBytes = positiveInteger(options.maxResponseBytes, 4 * 1024 * 1024, "maxResponseBytes");
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    assertTopLevel(key);
    const keyParameter = clickHouseParameter("id", key.id);
    const rows = await this.requestRows(
      `SELECT * FROM ${tableName(key.collection, this.#database)} AS t WHERE t.${quoteIdentifier(this.#idColumn)} = {id:${keyParameter.type}} LIMIT 2 FORMAT JSON`,
      [keyParameter],
      "get",
    );
    if (rows.length === 0) return { key, exists: false };
    if (rows.length > 1) throw new UnsupportedError("ClickHouse get requires a table whose idColumn is unique");
    const row = rows[0];
    if (row === undefined) throw new Error("missing ClickHouse get row");
    return { key, exists: true, data: identityOr(codec).decode(recordData(row, this.#idColumn)) };
  }

  public getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    return Promise.all(keys.map((key) => this.get(key, codec)));
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    const requested = query.limit ?? this.#maxResults;
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > this.#maxResults) {
      throw new RangeError(`ClickHouse query limit must be between 1 and ${String(this.#maxResults)}`);
    }
    const compiled = compileClickHouseQuery(query, {
      ...(this.#database === undefined ? {} : { database: this.#database }),
      idColumn: this.#idColumn,
      rowLimit: requested,
    });
    const rows = await this.requestRows(compiled.sql, compiled.parameters, "query");
    const codec = identityOr(query.source.codec);
    const records = rows.map((row): ExistingRecord<T> => ({
      key: new Key(query.source.name, keyValue(row, this.#idColumn)),
      exists: true,
      data: codec.decode(recordData(row, this.#idColumn)),
    }));
    const finalRow = rows.at(-1);
    const nextCursor = query.orders.length > 0 && records.length === requested && finalRow !== undefined
      ? { values: compiled.cursorColumns.map((column) => {
        const value = finalRow[column];
        if (value === null || value === undefined) throw new UnsupportedError("ClickHouse paginated order values must be non-null");
        return value;
      }) }
      : undefined;
    return { records, ...(nextCursor === undefined ? {} : { nextCursor }) };
  }

  /**
   * Sends JSONEachRow to an explicitly append-only ClickHouse table. It has no
   * DALgo unique-key or replace semantics; retries can create duplicate events.
   */
  public async append<T>(collection: string, values: readonly T[], codec?: Codec<T>): Promise<void> {
    tableName(collection, this.#database);
    if (values.length === 0) return;
    const lines = values.map((value) => {
      const encoded = identityOr(codec).encode(value);
      if (!isObject(encoded)) throw new TypeError("ClickHouse JSONEachRow append values must encode to objects");
      return JSON.stringify(encoded);
    });
    await this.request(`INSERT INTO ${tableName(collection, this.#database)} FORMAT JSONEachRow\n${lines.join("\n")}`, []);
  }

  public runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result> {
    if (typeof callback !== "function") throw new TypeError("transaction callback is required");
    return Promise.reject(new UnsupportedError("ClickHouse DALgo callback transactions"));
  }

  private async requestRows(sql: string, parameters: readonly ClickHouseParameter[], context: string): Promise<readonly Record<string, unknown>[]> {
    return asRows(await this.request(sql, parameters), context);
  }

  private async request(sql: string, parameters: readonly ClickHouseParameter[]): Promise<unknown> {
    const configured = typeof this.#headers === "function" ? await this.#headers() : (this.#headers ?? {});
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.#fetch(requestUrl(this.#baseUrl, parameters, this.#database), {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: { ...configured, accept: "application/json", "content-type": "text/plain; charset=utf-8" },
          body: sql,
        });
      } catch {
        throw new ClickHouseHttpError(0);
      }
      if (!response.ok) throw new ClickHouseHttpError(response.status);
      const text = await responseText(response, this.#maxResponseBytes);
      if (text.length === 0) return undefined;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new TypeError("malformed ClickHouse JSON response");
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
