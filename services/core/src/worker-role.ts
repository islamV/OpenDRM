import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import type pg from "pg";

// The administrator runs this after migrations on fresh and upgraded Compose databases.
export async function configureMediaRole(pool: pg.Pool, role: "shield_worker" | "shield_keybroker", password: string) {
  if (!/^[a-f0-9]{64}$/.test(password))
    throw new Error("Expected hex worker database credential");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(1415387099)");
    const existing = await client.query(
      "SELECT 1 FROM pg_roles WHERE rolname=$1", [role],
    );
    if (!existing.rowCount) await client.query(`CREATE ROLE ${role} LOGIN`);
    const salt = randomBytes(16);
    const salted = pbkdf2Sync(password, salt, 4096, 32, "sha256");
    const clientKey = createHmac("sha256", salted)
      .update("Client Key")
      .digest();
    const storedKey = createHash("sha256").update(clientKey).digest("base64");
    const serverKey = createHmac("sha256", salted)
      .update("Server Key")
      .digest("base64");
    const verifier = `SCRAM-SHA-256$4096:${salt.toString("base64")}$${storedKey}:${serverKey}`;
    await client.query(`ALTER ROLE ${role} PASSWORD '${verifier}'`);
    if(role === "shield_keybroker") {
      await client.query(`GRANT USAGE ON SCHEMA public TO shield_keybroker;
        GRANT SELECT(id,key_id,key_version,state) ON packaging_jobs TO shield_keybroker;
        GRANT SELECT(id,revoked_at) ON encryption_keys TO shield_keybroker;
        GRANT SELECT ON key_versions TO shield_keybroker`);
    } else await client.query(`GRANT USAGE ON SCHEMA public TO shield_worker;
      GRANT SELECT ON packaging_jobs,content_assets,encryption_keys,key_versions TO shield_worker;
      GRANT UPDATE(state,error_code,key_id,key_version) ON packaging_jobs TO shield_worker;
      GRANT INSERT ON encryption_keys,key_versions,packaging_outputs TO shield_worker;
      GRANT SELECT,INSERT ON media_wrapping_keys TO shield_worker;
      GRANT UPDATE(id) ON encryption_keys TO shield_worker`);
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK");
    throw new Error("Packaging role configuration failed");
  } finally {
    client.release();
  }
}
