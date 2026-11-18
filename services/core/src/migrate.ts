import { configureMediaRole } from "./worker-role.js";
import { openPool, migrate } from "./database.js";
const db = openPool(process.env.DATABASE_URL);
try {
  await migrate(db);
  if (process.env.WORKER_DB_PASSWORD)
    await configureMediaRole(db, "shield_worker", process.env.WORKER_DB_PASSWORD);
  if (process.env.KEYBROKER_DB_PASSWORD)
    await configureMediaRole(db, "shield_keybroker", process.env.KEYBROKER_DB_PASSWORD);
} finally {
  await db.end();
}
