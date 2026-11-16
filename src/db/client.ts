// The service's access to its own Postgres database, through the packaged
// in-process client postgres.js (docs/decisions/0001-in-process-postgres-client.md).
// Every statement is sent with its values as protocol parameters ($1, $2, ...),
// never spliced into the SQL text, and no external program is spawned.
import postgres from "postgres";

/** A value bound to a $n placeholder. Send JSON as its text with a ::jsonb cast. */
export type Param = string | number | boolean | null;
export type Row = Record<string, unknown>;

export interface Queryable {
  /** Run one parameterised statement; resolves with its rows (json/jsonb columns parsed). */
  query<T extends Row = Row>(text: string, params?: readonly Param[]): Promise<T[]>;
}

export interface Db extends Queryable {
  /**
   * Run `fn` in one transaction on one connection: committed when `fn`
   * resolves (with its value), rolled back when it rejects (with its error).
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Close the pool once running queries finish. */
  end(): Promise<void>;
}

type Runner = Pick<postgres.Sql, "unsafe">;

const queryable = (sql: Runner): Queryable => ({
  async query<T extends Row = Row>(text: string, params: readonly Param[] = []): Promise<T[]> {
    // `unsafe` names postgres.js's raw-text entry point; the values still go
    // as bound parameters. A copy drops the client's result-array extras.
    const rows = await sql.unsafe(text, [...params] as postgres.ParameterOrJSON<never>[]);
    return [...rows] as unknown as T[];
  },
});

/** A pooled client for `databaseUrl` (postgres://user:password@host:port/db). */
export function pgClient(databaseUrl: string): Db {
  const sql = postgres(databaseUrl, {
    max: 10,
    // A dropped idle connection is replaced on next use rather than kept open.
    idle_timeout: 60,
    connect_timeout: 30,
    // Server notices (e.g. "relation already exists, skipping") are not errors.
    onnotice: () => {},
    types: {
      // By default postgres.js JSON.stringifies any value bound to a json or
      // jsonb parameter, so JSON text would arrive as a JSON *string*. Params
      // are scalars here: JSON goes as its text, as libpq sends it.
      json: { to: 114, from: [114, 3802], serialize: (x: unknown) => String(x), parse: (x: string) => JSON.parse(x) as unknown },
    },
  });
  return {
    ...queryable(sql),
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return (await sql.begin((tx) => fn(queryable(tx)))) as T;
    },
    end: () => sql.end({ timeout: 5 }),
  };
}
