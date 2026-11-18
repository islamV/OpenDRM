import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../dist/app.js";
import { openPool, migrate, provision } from "../dist/database.js";

test("only a publisher owning the content can enqueue, inspect and rotate an asset", async () => {
  const db = openPool(process.env.TEST_DATABASE_URL);
  const directory = await mkdtemp(join(tmpdir(), "shield-upload-"));
  const app = await buildApp(db, directory);
  try {
    await migrate(db);
    async function signIn(role) {
      const { credential } = await provision(db, role);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/token",
        headers: { authorization: "Bearer " + credential },
      });
      return { authorization: "Bearer " + res.json().token };
    }
    const owner = await signIn("publisher"),
      other = await signIn("publisher");
    const content = await app.inject({
      method: "POST",
      url: "/api/v1/content",
      payload: { title: "Fixture" },
      headers: owner,
    });
    const url = "/api/v1/content/" + content.json().id + "/assets";
    const upload = (identity, data) =>
      app.inject({
        method: "POST",
        url,
        headers: { ...identity, "content-type": "video/mp4" },
        payload: data,
      });
    assert.equal((await upload({}, "test")).statusCode, 401);
    assert.equal((await upload(other, "test")).statusCode, 404);
    assert.equal((await upload(owner, "")).statusCode, 400);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: {
            ...owner,
            "content-type": "video/mp4",
            "content-length": String(128 * 1024 * 1024 + 1),
          },
          payload: "large",
        })
      ).statusCode,
      413,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: owner,
          payload: {},
        })
      ).statusCode,
      415,
    );
    const accepted = await upload(owner, Buffer.from("media-fixture"));
    assert.equal(accepted.statusCode, 202);
    const { jobId, assetId } = accepted.json();
    assert.equal(
      await readFile(join(directory, assetId + ".mp4"), "utf8"),
      "media-fixture",
    );
    const job = "/api/v1/jobs/" + jobId;
    assert.equal(
      (await app.inject({ url: job, headers: owner })).json().state,
      "queued",
    );
    assert.equal(
      (await app.inject({ url: job, headers: other })).statusCode,
      404,
    );
    const rotate = "/api/v1/assets/" + assetId + "/rotate";
    assert.equal(
      (await app.inject({ method: "POST", url: rotate, headers: other }))
        .statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ method: "POST", url: rotate, headers: owner }))
        .statusCode,
      409,
    );
  } finally {
    await app.close();
    await db.end();
    await rm(directory, { recursive: true, force: true });
  }
});
