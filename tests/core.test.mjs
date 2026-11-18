import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openPool, migrate, provision } from "../dist/database.js";
import { buildApp } from "../dist/app.js";

let db, app, owner, viewer;
before(async () => {
  db = openPool(process.env.TEST_DATABASE_URL);
  await Promise.all([migrate(db), migrate(db)]);
  app = await buildApp(db);
  owner = await provision(db, "publisher");
  viewer = await provision(db, "viewer");
});
after(async () => {
  await app?.close();
  await db?.end();
});
const send = (method, url, token, payload) =>
  app.inject({
    method,
    url,
    payload,
    headers: token ? { authorization: "Bearer " + token } : {},
  });
async function login(principal) {
  const res = await send("POST", "/api/v1/auth/token", principal.credential);
  assert.equal(res.statusCode, 201);
  return res.json().token;
}
test("migration re-entry and database-backed health", async () => {
  assert.equal((await send("GET", "/health")).statusCode, 200);
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0]
      .n,
    3,
  );
});
test("session issuance, expiry and revocation", async () => {
  assert.equal((await send("POST", "/api/v1/auth/token")).statusCode, 401);
  const token = await login(owner);
  assert.equal(
    (await send("POST", "/api/v1/auth/validate", token)).json().userId,
    owner.id,
  );
  assert.equal(
    (await send("DELETE", "/api/v1/auth/session", token)).statusCode,
    204,
  );
  assert.equal(
    (await send("POST", "/api/v1/auth/validate", token)).statusCode,
    401,
  );
  const expired = await login(viewer);
  await db.query("UPDATE auth_sessions SET expires_at=now() WHERE user_id=$1", [
    viewer.id,
  ]);
  assert.equal(
    (await send("POST", "/api/v1/auth/validate", expired)).statusCode,
    401,
  );
});
test("content creation validates permission, ownership and explicit entitlement", async () => {
  const publisher = await login(owner),
    reader = await login(viewer);
  const url = "/api/v1/content";
  assert.equal(
    (await send("POST", url, reader, { title: "Sample" })).statusCode,
    403,
  );
  assert.equal(
    (await send("POST", url, publisher, { title: "" })).statusCode,
    400,
  );
  const created = await send("POST", url, publisher, { title: "Sample" });
  assert.equal(created.statusCode, 201);
  const { id } = created.json();
  assert.equal(
    (await send("GET", url + "/" + id, publisher)).json().title,
    "Sample",
  );
  assert.equal((await send("GET", url + "/" + id, reader)).statusCode, 404);
  await db.query(
    "INSERT INTO content_entitlements(user_id,content_id) VALUES($1,$2)",
    [viewer.id, id],
  );
  assert.equal((await send("GET", url + "/" + id, reader)).statusCode, 200);
  await db.query(
    "UPDATE content_entitlements SET ends_at=now() WHERE user_id=$1",
    [viewer.id],
  );
  assert.equal((await send("GET", url + "/" + id, reader)).statusCode, 404);
  assert.equal((await send("GET", url + "/" + randomUUID())).statusCode, 401);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE actor_id=$1 AND event='content.created'",
        [owner.id],
      )
    ).rows[0].n,
    1,
  );
});
test("failed provisioning rolls back the principal", async () => {
  const count = async () =>
    (await db.query("SELECT count(*) AS n FROM users")).rows[0].n;
  const before = await count();
  await assert.rejects(provision(db, "missing-role"));
  assert.equal(await count(), before);
});
test("disabled users lose access and credentials cannot be used as sessions", async () => {
  const person = await provision(db, "viewer");
  const token = await login(person);
  assert.equal(
    (await send("POST", "/api/v1/auth/validate", person.credential)).statusCode,
    401,
  );
  await db.query("UPDATE users SET disabled=true WHERE id=$1", [person.id]);
  assert.equal(
    (await send("POST", "/api/v1/auth/validate", token)).statusCode,
    401,
  );
  assert.equal(
    (await send("POST", "/api/v1/auth/token", person.credential)).statusCode,
    401,
  );
});
test("token exchange is rate limited", async () => {
  const attempts = [];
  for (let i = 0; i < 11; i++)
    attempts.push((await send("POST", "/api/v1/auth/token")).statusCode);
  assert.ok(attempts.includes(429));
});
