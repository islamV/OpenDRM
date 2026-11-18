import { buildApp } from "./app.js";
import { openPool } from "./database.js";
const db = openPool(process.env.DATABASE_URL);
const app = await buildApp(db);
app.addHook("onClose", async () => {
  await db.end();
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    void app.close();
  });
await app.listen({
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
});
