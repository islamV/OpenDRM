import { openPool, migrate } from "./database.js";
const db = openPool(process.env.DATABASE_URL);
try {
  await migrate(db);
} finally {
  await db.end();
}
