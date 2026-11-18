import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { digest, newSecret } from "./database.js";

const params = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
};
const formats = new Map([
  ["manifest.mpd", "application/dash+xml"],
  ["master.m3u8", "application/vnd.apple.mpegurl"],
  ["audio.m3u8", "application/vnd.apple.mpegurl"],
  ["video.m3u8", "application/vnd.apple.mpegurl"],
  ["audio.mp4", "audio/mp4"],
  ["video.mp4", "video/mp4"],
]);

// Both creation and delivery evaluate the same current job, key and entitlement.
const media = `JOIN content_assets a ON a.id=j.asset_id
  JOIN content c ON c.id=a.content_id
  JOIN encryption_keys k ON k.id=j.key_id AND k.content_id=c.id
  JOIN key_versions v ON v.key_id=j.key_id AND v.version=j.key_version`;
const allowed = `s.revoked_at IS NULL AND s.expires_at>now() AND NOT u.disabled
  AND j.state='completed' AND k.revoked_at IS NULL
  AND (u.id=c.owner_id OR EXISTS (SELECT 1 FROM content_entitlements e
    LEFT JOIN subscriptions b ON b.id=e.subscription_id AND b.user_id=e.user_id
    WHERE e.user_id=u.id AND e.content_id=c.id AND (e.ends_at IS NULL OR e.ends_at>now())
      AND (e.subscription_id IS NULL OR (b.starts_at<=now() AND b.ends_at>now()))))`;

function byteRange(header: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !size || (!match[1] && !match[2])) return;
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return;
  const start = match[1] ? first : Math.max(0, size - last);
  const end = match[1] && match[2] ? Math.min(last, size - 1) : size - 1;
  if (start <= end && start < size) return { start, end };
}

type WithId = { Params: { id: string } };

export function playbackRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  bearer: (req: FastifyRequest) => string | undefined,
  principal: (req: FastifyRequest) => Promise<string | undefined>,
) {
  const broker = process.env.KEYBROKER_URL;
  const secret = process.env.KEYBROKER_TOKEN;
  const enabled = Boolean(broker && secret);
  const output = process.env.MEDIA_OUTPUT_DIR ?? "/media/output";

  async function authorized(req: FastifyRequest<WithId>) {
    const token = bearer(req);
    if (!enabled || !token) return;
    const result = await pool.query<{ job_id: string; kid: string }>(
      `
      SELECT p.job_id,p.kid FROM playback_sessions p
      JOIN auth_sessions s ON s.token_hash=p.auth_session_hash
      JOIN users u ON u.id=s.user_id JOIN packaging_jobs j ON j.id=p.job_id
      ${media}
      WHERE p.id=$1 AND p.token_hash=$2 AND p.revoked_at IS NULL AND p.expires_at>now()
        AND p.content_id=c.id AND p.kid=v.kid AND ${allowed}`,
      [req.params.id, digest(token)],
    );
    return result.rows[0];
  }

  app.get("/api/v1/license/capabilities", async () => ({
    clearkey: enabled,
    widevine: false,
    fairplay: false,
  }));

  app.post<WithId>(
    "/api/v1/jobs/:id/playback",
    { schema: { params } },
    async (req, reply) => {
      if (!enabled) return reply.code(503).send();
      const auth = bearer(req);
      if (!auth || !(await principal(req))) return reply.code(401).send();
      const token = newSecret();
      const result = await pool.query<{ id: string; ttl: number }>(
        `
      INSERT INTO playback_sessions(content_id,expires_at,auth_session_hash,token_hash,job_id,kid)
      SELECT c.id,least(s.expires_at,now()+interval '5 minutes'),s.token_hash,$3,j.id,v.kid
      FROM auth_sessions s JOIN users u ON u.id=s.user_id JOIN packaging_jobs j ON j.id=$1
      ${media} WHERE s.token_hash=$2 AND ${allowed}
      RETURNING id,floor(extract(epoch FROM expires_at-now()))::int AS ttl`,
        [req.params.id, digest(auth), digest(token)],
      );
      const row = result.rows[0];
      if (!row) return reply.code(404).send();
      const base = "/api/v1/playback/" + row.id;
      return reply.code(201).send({
        token,
        sessionId: row.id,
        manifestUrl: base + "/media/manifest.mpd",
        licenseUrl: base + "/license",
        expiresIn: row.ttl,
      });
    },
  );

  app.delete<WithId>(
    "/api/v1/playback/:id",
    { schema: { params } },
    async (req, reply) => {
      const user = await principal(req);
      if (!user) {
        const token = bearer(req);
        if (!token) return reply.code(401).send();
        const revoked = await pool.query(
          `
        UPDATE playback_sessions SET revoked_at=now()
        WHERE id=$1 AND token_hash=$2 AND revoked_at IS NULL`,
          [req.params.id, digest(token)],
        );
        return reply.code(revoked.rowCount ? 204 : 401).send();
      }
      const result = await pool.query(
        `
      UPDATE playback_sessions p SET revoked_at=now() FROM auth_sessions s
      WHERE p.auth_session_hash=s.token_hash AND s.user_id=$1 AND p.id=$2 AND p.revoked_at IS NULL`,
        [user, req.params.id],
      );
      return reply.code(result.rowCount ? 204 : 404).send();
    },
  );

  app.post<WithId & { Body: { kids: string[]; type?: string } }>(
    "/api/v1/playback/:id/license",
    {
      // CDMs send a UTF-8 JSON message as a BufferSource. Players can omit its MIME type.
      onRequest: async (req) => {
        const mime = req.headers["content-type"]?.split(";")[0]?.trim();
        if (!mime || mime === "application/octet-stream")
          req.headers["content-type"] = "application/json";
      },
      schema: {
        params,
        body: {
          type: "object",
          required: ["kids"],
          additionalProperties: false,
          properties: {
            kids: {
              type: "array",
              minItems: 1,
              maxItems: 1,
              items: { type: "string", pattern: "^[A-Za-z0-9_-]{22}$" },
            },
            type: { const: "temporary" },
          },
        },
      },
    },
    async (req, reply) => {
      const grant = await authorized(req);
      if (!grant) return reply.code(401).send();
      const kid = Buffer.from(grant.kid.replaceAll("-", ""), "hex").toString(
        "base64url",
      );
      if (req.body.kids[0] !== kid) return reply.code(403).send();
      try {
        const response = await fetch(new URL("/unwrap", broker), {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(3000),
          headers: {
            authorization: "Bearer " + secret,
            "content-type": "application/json",
          },
          body: JSON.stringify({ jobId: grant.job_id, kid: grant.kid }),
        });
        if (response.status === 404) return reply.code(403).send();
        if (!response.ok) return reply.code(503).send();
        const { k } = (await response.json()) as { k?: string };
        if (typeof k !== "string" || !/^[A-Za-z0-9_-]{21}[AQgw]$/.test(k))
          return reply.code(503).send();
        if (!(await authorized(req))) return reply.code(401).send();
        return { keys: [{ kty: "oct", kid, k }], type: "temporary" };
      } catch {
        return reply.code(503).send();
      }
    },
  );

  app.route<{ Params: { id: string; filename: string } }>({
    method: ["GET", "HEAD"],
    url: "/api/v1/playback/:id/media/:filename",
    schema: { params },
    async handler(req, reply) {
      const grant = await authorized(req);
      if (!grant) return reply.code(401).send();
      const filename = req.params.filename;
      const format = formats.get(filename);
      if (!format) return reply.code(404).send();
      // The worker publishes each completed UUID directory by atomic rename.
      const directory = join(output, grant.job_id);
      const parent = await lstat(directory).catch(
        (err: NodeJS.ErrnoException) => {
          if (err.code !== "ENOENT") throw err;
          return undefined;
        },
      );
      if (!parent?.isDirectory()) return reply.code(404).send();
      const file = await open(
        join(directory, filename),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      ).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT" && err.code !== "ELOOP") throw err;
        return undefined;
      });
      if (!file) return reply.code(404).send();
      let transferred = false;
      try {
        const stat = await file.stat();
        if (!stat.isFile()) return reply.code(404).send();
        const size = stat.size;
        const header = req.headers.range;
        const range = header ? byteRange(header, size) : undefined;
        reply.header("Accept-Ranges", "bytes");
        if (header && !range)
          return reply
            .code(416)
            .header("Content-Range", "bytes */" + size)
            .send();
        if (range)
          reply
            .code(206)
            .header(
              "Content-Range",
              `bytes ${range.start}-${range.end}/${size}`,
            );
        reply
          .type(format)
          .header("Content-Length", range ? range.end - range.start + 1 : size);
        if (req.method === "HEAD" || !size) return reply.send();
        const stream = file.createReadStream(range);
        transferred = true;
        return reply.send(stream);
      } finally {
        if (!transferred) await file.close();
      }
    },
  });
}
