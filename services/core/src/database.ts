import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";

export function openPool(url: string | undefined) {
  if (!url) throw new Error("A PostgreSQL connection URL is required");
  return new pg.Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 5000,
  });
}
export const digest = (value: string) =>
  createHash("sha256").update(value).digest();
export const newSecret = () => randomBytes(32).toString("base64url");

export async function migrate(pool: pg.Pool) {
  const directory = new URL("../database/migrations/", import.meta.url);
  const files = (await readdir(directory))
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(1415387099)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum bytea NOT NULL)",
    );
    for (const name of files) {
      const source = await readFile(new URL(name, directory), "utf8");
      const applied = await client.query(
        "SELECT checksum FROM schema_migrations WHERE name=$1",
        [name],
      );
      if (applied.rowCount) {
        if (!digest(source).equals(applied.rows[0].checksum))
          throw new Error("Changed migration: " + name);
        continue;
      }
      await client.query(source);
      await client.query("INSERT INTO schema_migrations VALUES ($1,$2)", [
        name,
        digest(source),
      ]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
export async function provision(pool: pg.Pool, role: string) {
  const credential = newSecret();
  const id = await drizzle(pool).transaction(async (tx) => {
    const result = await tx.execute<{ id: string }>(
      sql`INSERT INTO users(credential_hash) VALUES(${digest(credential)}) RETURNING id`,
    );
    const id = result.rows[0]!.id;
    await tx.execute(
      sql`INSERT INTO user_roles(user_id,role) VALUES(${id},${role})`,
    );
    await tx.execute(
      sql`INSERT INTO audit_logs(actor_id,event) VALUES(${id},'user.provisioned')`,
    );
    return id;
  });
  return { id, credential };
}
