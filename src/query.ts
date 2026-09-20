import {
  DOCUMENT_ID,
  UnsupportedError,
  type QueryFilter,
  type QueryOrder,
  type StructuredQuery,
} from "@dal-go/dalgo";

export interface ClickHouseParameter {
  readonly name: string;
  readonly type: string;
  readonly value: string;
}

export interface ClickHouseQueryOptions {
  readonly database?: string;
  readonly idColumn: string;
  readonly rowLimit: number;
}

export interface CompiledClickHouseQuery {
  readonly sql: string;
  readonly parameters: readonly ClickHouseParameter[];
  readonly cursorColumns: readonly string[];
}

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function quoteIdentifier(value: string, label = "identifier"): string {
  if (!identifier.test(value)) throw new TypeError(`${label} must be a simple ClickHouse identifier`);
  return `\`${value}\``;
}

function tableExpression(collection: string, database: string | undefined): string {
  const table = quoteIdentifier(collection, "ClickHouse collection/table name");
  return database === undefined ? table : `${quoteIdentifier(database, "ClickHouse database name")}.${table}`;
}

function columnExpression(field: string, idColumn: string): string {
  const column = field === DOCUMENT_ID ? idColumn : field;
  return `t.${quoteIdentifier(column, "ClickHouse field name")}`;
}

function requireStringKeyFilter<T>(filter: QueryFilter<T>): void {
  if (filter.field !== DOCUMENT_ID) return;
  const values = Array.isArray(filter.value) ? filter.value : [filter.value];
  if (values.some((value) => typeof value !== "string")) {
    throw new TypeError("ClickHouse document-ID filters require string DALgo IDs");
  }
}

function escapedString(value: string): string {
  let result = "";
  for (const character of value) {
    if (character === "\t") result += "\\t";
    else if (character === "\n") result += "\\n";
    else if (character === "\r") result += "\\r";
    else if (character === "'") result += "\\'";
    else if (character === "\\") result += "\\\\";
    else result += character;
  }
  return result;
}

function scalar(value: unknown, inArray = false): { readonly type: string; readonly value: string } {
  if (typeof value === "string") return { type: "String", value: inArray ? `'${escapedString(value)}'` : escapedString(value) };
  if (typeof value === "boolean") return { type: "Bool", value: inArray ? value ? "TRUE" : "FALSE" : value ? "1" : "0" };
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isSafeInteger(value)) {
      return value >= 0 ? { type: "UInt64", value: String(value) } : { type: "Int64", value: String(value) };
    }
    return { type: "Float64", value: String(value) };
  }
  throw new TypeError("ClickHouse parameters must be strings, booleans, or finite numbers");
}

export function clickHouseParameter(name: string, value: unknown): ClickHouseParameter {
  if (Array.isArray(value)) {
    if (value.length === 0) throw new TypeError("ClickHouse membership filters require a non-empty array");
    const values = value.map((item) => scalar(item, true));
    const first = values[0];
    if (first === undefined || values.some((item) => item.type !== first.type)) {
      throw new TypeError("ClickHouse membership filters require homogeneous scalar arrays");
    }
    return { name, type: `Array(${first.type})`, value: `[${values.map((item) => item.value).join(",")}]` };
  }
  const typed = scalar(value);
  return { name, ...typed };
}

function filterSql<T>(filter: QueryFilter<T>, index: number, idColumn: string): { readonly sql: string; readonly parameter?: ClickHouseParameter } {
  requireStringKeyFilter(filter);
  const expression = columnExpression(String(filter.field), idColumn);
  const name = `p${String(index)}`;
  switch (filter.operator) {
    case "==": return filter.value === null
      ? { sql: `${expression} IS NULL` }
      : (() => {
        const value = clickHouseParameter(name, filter.value);
        return { sql: `${expression} = {${name}:${value.type}}`, parameter: value };
      })();
    case "!=": return filter.value === null
      ? { sql: `${expression} IS NOT NULL` }
      : (() => {
        const value = clickHouseParameter(name, filter.value);
        return { sql: `${expression} IS NOT NULL AND ${expression} != {${name}:${value.type}}`, parameter: value };
      })();
    case "<":
    case "<=":
    case ">":
    case ">=": {
      const value = clickHouseParameter(name, filter.value);
      return { sql: `${expression} ${filter.operator} {${name}:${value.type}}`, parameter: value };
    }
    case "in":
    case "not-in": {
      const value = clickHouseParameter(name, filter.value);
      if (!value.type.startsWith("Array(")) throw new TypeError(`${filter.operator} requires an array`);
      const prefix = filter.operator === "not-in" ? `${expression} IS NOT NULL AND ` : "";
      return { sql: `${prefix}${expression} ${filter.operator === "in" ? "IN" : "NOT IN"} {${name}:${value.type}}`, parameter: value };
    }
    case "array-contains":
    case "array-contains-any":
      throw new UnsupportedError(`ClickHouse ${filter.operator} filters`);
  }
}

function orderColumns<T>(orders: readonly QueryOrder<T>[], idColumn: string): readonly string[] {
  const columns = orders.map((order) => order.field === DOCUMENT_ID ? idColumn : String(order.field));
  for (const column of columns) quoteIdentifier(column, "ClickHouse order field");
  return columns.includes(idColumn) ? columns : [...columns, idColumn];
}

function orderSql<T>(orders: readonly QueryOrder<T>[], columns: readonly string[]): string {
  return columns.map((column, index) => {
    const explicit = orders[index];
    return `${columnExpression(column, column)} ${explicit?.direction === "desc" ? "DESC" : "ASC"}`;
  }).join(", ");
}

function cursorSql<T>(
  query: StructuredQuery<T>,
  columns: readonly string[],
  idColumn: string,
  parameters: ClickHouseParameter[],
): string | undefined {
  if (query.startAt !== undefined || query.endAt !== undefined || query.endBefore !== undefined) {
    throw new UnsupportedError("ClickHouse inclusive or end cursors");
  }
  if (query.startAfter === undefined) return undefined;
  if (query.orders.length === 0) throw new UnsupportedError("ClickHouse startAfter without an explicit order");
  if ((query.offset ?? 0) !== 0) throw new UnsupportedError("ClickHouse startAfter combined with offset");
  if (query.startAfter.values.length !== columns.length) {
    throw new TypeError("ClickHouse cursor value count must include every order field and the key tie-breaker");
  }
  const terms: string[] = [];
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index];
    const cursorValue = query.startAfter.values[index];
    if (column === undefined || cursorValue === undefined || cursorValue === null) {
      throw new UnsupportedError("ClickHouse cursors require non-null scalar values");
    }
    if (column === idColumn && typeof cursorValue !== "string") {
      throw new TypeError("ClickHouse document-ID cursor values require string DALgo IDs");
    }
    const parameterName = `c${String(index)}`;
    const value = clickHouseParameter(parameterName, cursorValue);
    parameters.push(value);
    const equal = columns.slice(0, index).map((previous, previousIndex) => {
      const previousParameter = parameters.find((item) => item.name === `c${String(previousIndex)}`);
      if (previousParameter === undefined) throw new Error("missing ClickHouse cursor parameter");
      return `${columnExpression(previous, previous)} = {${previousParameter.name}:${previousParameter.type}}`;
    });
    const direction = query.orders[index]?.direction ?? "asc";
    terms.push(`(${[...equal, `${columnExpression(column, column)} ${direction === "desc" ? "<" : ">"} {${parameterName}:${value.type}}`].join(" AND ")})`);
  }
  return `(${terms.join(" OR ")})`;
}

/** Compiles a deliberately small, parameterized subset of DALgo structured queries. */
export function compileClickHouseQuery<T>(query: StructuredQuery<T>, options: ClickHouseQueryOptions): CompiledClickHouseQuery {
  if (query.source.kind !== "collection" || query.source.parent !== undefined) {
    throw new UnsupportedError("ClickHouse collection-group or nested collection queries");
  }
  if (!Number.isSafeInteger(options.rowLimit) || options.rowLimit < 1) {
    throw new TypeError("ClickHouse rowLimit must be a positive safe integer");
  }
  quoteIdentifier(options.idColumn, "ClickHouse idColumn");
  const parameters: ClickHouseParameter[] = [];
  const clauses = query.filters.map((filter, index) => {
    const compiled = filterSql(filter, index, options.idColumn);
    if (compiled.parameter !== undefined) parameters.push(compiled.parameter);
    return compiled.sql;
  });
  const cursorColumns = orderColumns(query.orders, options.idColumn);
  const cursor = cursorSql(query, cursorColumns, options.idColumn, parameters);
  if (cursor !== undefined) clauses.push(cursor);
  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  const order = query.orders.length === 0 ? "" : ` ORDER BY ${orderSql(query.orders, cursorColumns)}`;
  const limit = clickHouseParameter("limit", options.rowLimit);
  parameters.push(limit);
  const offset = query.offset === undefined ? "" : (() => {
    const value = clickHouseParameter("offset", query.offset);
    parameters.push(value);
    return ` OFFSET {${value.name}:${value.type}}`;
  })();
  return {
    sql: `SELECT * FROM ${tableExpression(query.source.name, options.database)} AS t${where}${order} LIMIT {${limit.name}:${limit.type}}${offset} FORMAT JSON`,
    parameters,
    cursorColumns,
  };
}
