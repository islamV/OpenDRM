import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../dist/app.js";
import { digest, openPool, migrate, provision } from "../dist/database.js";

let db, app, broker, dir, owner, viewer, outsider, job, content, kid, keyId;
const k = randomBytes(16).toString("base64url");
const brokerCalls = [];
const send = (method, url, token, payload, headers = {}) =>
  app.inject({
    method,
    url,
    payload,
    headers: {
      ...headers,
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
  });
async function user(role) {
  const person = await provision(db, role);
  const response = await send("POST", "/api/v1/auth/token", person.credential);
  assert.equal(response.statusCode, 201);
  return { id: person.id, token: response.json().token };
}
const start = (token) =>
  send("POST", "/api/v1/jobs/" + job + "/playback", token);
async function session(token) {
  const response = await start(token);
  assert.equal(response.statusCode, 201);
  return response.json();
}
const challenge = () => ({
  kids: [Buffer.from(kid.replaceAll("-", ""), "hex").toString("base64url")],
  type: "temporary",
});

before(async () => {
  db = openPool(process.env.TEST_DATABASE_URL);
  await migrate(db);
  dir = await mkdtemp(join(tmpdir(), "shield-playback-"));
  broker = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    brokerCalls.push({
      body: JSON.parse(body),
      url: req.url,
      auth: req.headers.authorization,
    });
    res.end(JSON.stringify({ k }));
  });
  await new Promise((resolve) => broker.listen(0, "127.0.0.1", resolve));
  process.env.MEDIA_OUTPUT_DIR = dir;
  process.env.KEYBROKER_URL = "http://127.0.0.1:" + broker.address().port;
  process.env.KEYBROKER_TOKEN = randomBytes(32).toString("hex");
  app = await buildApp(db);
  owner = await user("publisher");
  viewer = await user("viewer");
  outsider = await user("viewer");
  content = (
    await send("POST", "/api/v1/content", owner.token, { title: "Test film" })
  ).json().id;
  keyId = randomUUID();
  kid = randomUUID();
  const asset = randomUUID();
  job = randomUUID();
  await db.query(
    "INSERT INTO content_assets(id,content_id,storage_path) VALUES($1,$2,$3)",
    [asset, content, asset + ".mp4"],
  );
  await db.query("INSERT INTO encryption_keys(id,content_id) VALUES($1,$2)", [
    keyId,
    content,
  ]);
  await db.query(
    "INSERT INTO key_versions VALUES($1,1,$2,'test',$3,$3,$4,$5)",
    [keyId, kid, Buffer.alloc(32), Buffer.alloc(12), Buffer.alloc(16)],
  );
  await db.query(
    "INSERT INTO packaging_jobs(id,asset_id,key_id,key_version,state) VALUES($1,$2,$3,1,'completed')",
    [job, asset, keyId],
  );
  await mkdir(join(dir, job));
  await writeFile(join(dir, job, "manifest.mpd"), "<MPD/>");
  await writeFile(join(dir, job, "video.mp4"), "0123456789");
  await symlink(join(dir, job, "manifest.mpd"), join(dir, job, "audio.mp4"));
});
after(async () => {
  await app?.close();
  if (broker) await new Promise((resolve) => broker.close(resolve));
  await db?.end();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("owner obtains a session bound to one job, token and KID", async () => {
  assert.deepEqual((await send("GET", "/api/v1/license/capabilities")).json(), {
    clearkey: true,
    widevine: false,
    fairplay: false,
  });
  assert.equal((await start()).statusCode, 401);
  assert.equal((await start(outsider.token)).statusCode, 404);
  const one = await session(owner.token);
  const two = await session(owner.token);
  assert.ok(one.expiresIn > 0 && one.expiresIn <= 300);
  const stored = await db.query(
    "SELECT token_hash FROM playback_sessions WHERE id=$1",
    [one.sessionId],
  );
  assert.deepEqual(stored.rows[0].token_hash, digest(one.token));
  assert.equal((await send("GET", one.manifestUrl, two.token)).statusCode, 401);
  assert.equal(
    (await send("GET", one.manifestUrl, owner.token)).statusCode,
    401,
  );
  assert.equal((await send("GET", one.manifestUrl, one.token)).body, "<MPD/>");
  const request = challenge();
  const count = brokerCalls.length;
  assert.equal(
    (
      await send("POST", one.licenseUrl, one.token, {
        kids: [randomBytes(16).toString("base64url")],
      })
    ).statusCode,
    403,
  );
  assert.equal(brokerCalls.length, count);
  const license = await send(
    "POST",
    one.licenseUrl,
    one.token,
    Buffer.from(JSON.stringify(request)),
    { "content-type": "application/octet-stream" },
  );
  assert.equal(license.statusCode, 200);
  assert.deepEqual(license.json(), {
    keys: [{ kty: "oct", kid: request.kids[0], k }],
    type: "temporary",
  });
  assert.deepEqual(brokerCalls.at(-1), {
    body: { jobId: job, kid },
    auth: "Bearer " + process.env.KEYBROKER_TOKEN,
    url: "/unwrap",
  });
  const revoke = "/api/v1/playback/" + one.sessionId;
  assert.equal((await send("DELETE", revoke, outsider.token)).statusCode, 404);
  assert.equal((await send("DELETE", revoke, two.token)).statusCode, 401);
  assert.equal((await send("DELETE", revoke, owner.token)).statusCode, 204);
  assert.equal(
    (await send("DELETE", "/api/v1/playback/" + two.sessionId, two.token))
      .statusCode,
    204,
  );
  assert.equal((await send("GET", two.manifestUrl, two.token)).statusCode, 401);
  assert.equal(
    (await send("POST", one.licenseUrl, one.token, request)).statusCode,
    401,
  );
});

test("protected media supports HEAD, byte ranges and allowlisted regular files", async () => {
  const s = await session(owner.token);
  const url = s.manifestUrl.replace("manifest.mpd", "video.mp4");
  for (const [range, expected] of [
    ["bytes=2-4", "234"],
    ["bytes=-2", "89"],
    ["bytes=7-", "789"],
    ["bytes=8-100", "89"],
  ]) {
    const part = await send("GET", url, s.token, undefined, { range });
    assert.equal(part.statusCode, 206);
    assert.equal(part.body, expected);
    assert.equal(Number(part.headers["content-length"]), expected.length);
  }
  const head = await send("HEAD", url, s.token, undefined, {
    range: "bytes=2-4",
  });
  assert.equal(head.body, "");
  assert.equal(head.statusCode, 206);
  assert.equal(head.headers["content-range"], "bytes 2-4/10");
  assert.equal(head.headers["content-length"], "3");
  for (const range of ["bytes=10-", "bytes=-0", "bytes=0-2,4-5", "bytes=4-3"]) {
    const rejected = await send("GET", url, s.token, undefined, { range });
    assert.equal(rejected.statusCode, 416);
    assert.equal(rejected.headers["content-range"], "bytes */10");
  }
  for (const name of ["audio.mp4", "error.log", "audio.m3u8"])
    assert.equal(
      (await send("GET", s.manifestUrl.replace("manifest.mpd", name), s.token))
        .statusCode,
      404,
    );
});

test("delivery rechecks subscription, user, auth session, key and job state", async () => {
  const subscription = randomUUID();
  await db.query(
    "INSERT INTO subscriptions(id,user_id,starts_at,ends_at) VALUES($1,$2,now()-interval '1 day',now()+interval '1 day')",
    [subscription, viewer.id],
  );
  await db.query(
    "INSERT INTO content_entitlements(content_id,user_id,subscription_id) VALUES($1,$2,$3)",
    [content, viewer.id, subscription],
  );
  const s = await session(viewer.token);
  const verify = async (status) => {
    assert.equal(
      (await send("GET", s.manifestUrl, s.token)).statusCode,
      status,
    );
    assert.equal(
      (await send("POST", s.licenseUrl, s.token, challenge())).statusCode,
      status,
    );
  };
  await verify(200);
  for (const [off, on, values] of [
    [
      "UPDATE subscriptions SET ends_at=now() WHERE id=$1",
      "UPDATE subscriptions SET ends_at=now()+interval '1 day' WHERE id=$1",
      [subscription],
    ],
    [
      "UPDATE content_entitlements SET ends_at=now() WHERE user_id=$1",
      "UPDATE content_entitlements SET ends_at=NULL WHERE user_id=$1",
      [viewer.id],
    ],
    [
      "UPDATE users SET disabled=true WHERE id=$1",
      "UPDATE users SET disabled=false WHERE id=$1",
      [viewer.id],
    ],
    [
      "UPDATE encryption_keys SET revoked_at=now() WHERE id=$1",
      "UPDATE encryption_keys SET revoked_at=NULL WHERE id=$1",
      [keyId],
    ],
    [
      "UPDATE packaging_jobs SET state='failed' WHERE id=$1",
      "UPDATE packaging_jobs SET state='completed' WHERE id=$1",
      [job],
    ],
    [
      "UPDATE auth_sessions SET expires_at=now() WHERE token_hash=$1",
      "UPDATE auth_sessions SET expires_at=now()+interval '1 minute' WHERE token_hash=$1",
      [digest(viewer.token)],
    ],
    [
      "UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1",
      "UPDATE auth_sessions SET revoked_at=NULL WHERE token_hash=$1",
      [digest(viewer.token)],
    ],
    [
      "UPDATE playback_sessions SET expires_at=now() WHERE id=$1",
      "UPDATE playback_sessions SET expires_at=now()+interval '1 minute' WHERE id=$1",
      [s.sessionId],
    ],
  ]) {
    await db.query(off, values);
    await verify(401);
    await db.query(on, values);
    await verify(200);
  }
});
