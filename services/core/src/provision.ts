import { openPool, provision } from "./database.js";
const role = process.argv[2];
if (role !== "viewer" && role !== "publisher")
  throw new Error("Expected viewer or publisher");
const db = openPool(process.env.DATABASE_URL);
try {
  console.log(JSON.stringify(await provision(db, role)));
} finally {
  await db.end();
}
