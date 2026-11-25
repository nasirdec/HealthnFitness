// Small D1 helpers. D1 allows at most 100 bound parameters per statement and the
// Workers free plan caps queries per request, so bulk writes are packed into
// multi-row statements and sent in one batch.

export type Row = Record<string, unknown>;

export const MAX_BULK_ROWS = 800;

export function bulkStatements(
  db: D1Database,
  verb: "INSERT" | "INSERT OR REPLACE" | "INSERT OR IGNORE",
  table: string,
  cols: string[],
  rows: unknown[][],
): D1PreparedStatement[] {
  const perStmt = Math.max(1, Math.floor(100 / cols.length));
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += perStmt) {
    const chunk = rows.slice(i, i + perStmt);
    const placeholders = chunk.map(() => `(${cols.map(() => "?").join(",")})`).join(",");
    stmts.push(
      db.prepare(`${verb} INTO ${table} (${cols.join(",")}) VALUES ${placeholders}`).bind(...chunk.flat().map(nullify)),
    );
  }
  return stmts;
}

function nullify(v: unknown) {
  return v === undefined || (typeof v === "number" && !Number.isFinite(v)) ? null : v;
}

export async function all<T = Row>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const res = await db.prepare(sql).bind(...params.map(nullify)).all<T>();
  return res.results ?? [];
}

export async function first<T = Row>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return db.prepare(sql).bind(...params.map(nullify)).first<T>();
}

export async function run(db: D1Database, sql: string, ...params: unknown[]) {
  return db.prepare(sql).bind(...params.map(nullify)).run();
}

/** Insert a row from an object, keeping only allowed columns. Returns the new id. */
export async function insertRow(db: D1Database, table: string, allowed: string[], data: Row): Promise<number> {
  const cols = allowed.filter((c) => data[c] !== undefined);
  const res = await run(
    db,
    `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
    ...cols.map((c) => data[c]),
  );
  return Number(res.meta.last_row_id);
}

export async function updateRow(db: D1Database, table: string, allowed: string[], id: number, data: Row) {
  const cols = allowed.filter((c) => data[c] !== undefined);
  if (!cols.length) return;
  await run(db, `UPDATE ${table} SET ${cols.map((c) => `${c}=?`).join(",")} WHERE id=?`, ...cols.map((c) => data[c]), id);
}
