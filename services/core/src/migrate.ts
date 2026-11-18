import { configureWorker } from "./worker-role.js";
import { openPool, migrate } from "./database.js";
const db = openPool(process.env.DATABASE_URL);
try {
  await migrate(db);
  if (process.env.WORKER_DB_PASSWORD)
    await configureWorker(db, process.env.WORKER_DB_PASSWORD);
} finally {
  await db.end();
}
