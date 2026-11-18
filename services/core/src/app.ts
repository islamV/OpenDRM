import Fastify, { type FastifyRequest } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { digest, newSecret } from "./database.js";

import { registerStudio } from "./studio.js";
import { playbackRoutes } from "./playback.js";
import { mediaRoutes } from "./media-api.js";

function bearer(req: FastifyRequest) {
  return /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
    req.headers.authorization ?? "",
  )?.[1];
}

export async function buildApp(pool: pg.Pool, inputDir = "/media/input") {
  const app = Fastify({
    bodyLimit: 8192,
    requestTimeout: 300000,
    ajv: { customOptions: { removeAdditional: false } },
  });
  const db = drizzle(pool);
  await app.register(helmet);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.addHook("onSend", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    reply
      .code(status)
      .send({ error: status >= 500 ? "Service error" : "Request rejected" });
  });
  async function principal(req: FastifyRequest) {
    const token = bearer(req);
    if (!token) return;
    const result = await db.execute<{ id: string }>(sql`
      SELECT u.id FROM users u JOIN auth_sessions s ON s.user_id=u.id
      WHERE s.token_hash=${digest(token)} AND s.revoked_at IS NULL
        AND s.expires_at>now() AND NOT u.disabled`);
    return result.rows[0]?.id;
  }
  app.register(async (scope) => playbackRoutes(scope, pool, bearer, principal));
  app.get("/health", async (_req, reply) => {
    try {
      await pool.query("SELECT id FROM users LIMIT 0");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });
  app.post(
    "/api/v1/auth/token",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const credential = bearer(req);
      if (!credential) return reply.code(401).send();
      const token = newSecret();
      const result = await db.execute(sql`
      INSERT INTO auth_sessions(user_id,token_hash,expires_at)
      SELECT id,${digest(token)},now()+interval '15 minutes' FROM users
      WHERE credential_hash=${digest(credential)} AND NOT disabled RETURNING user_id`);
      if (!result.rowCount) return reply.code(401).send();
      return reply.code(201).send({ token, expiresIn: 900 });
    },
  );
  app.post("/api/v1/auth/validate", async (req, reply) => {
    const userId = await principal(req);
    if (!userId) return reply.code(401).send();
    return { userId };
  });
  app.delete("/api/v1/auth/session", async (req, reply) => {
    const token = bearer(req);
    if (!token) return reply.code(401).send();
    const result = await db.execute(sql`
      UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=${digest(token)}
      AND revoked_at IS NULL AND expires_at>now() RETURNING user_id`);
    return reply.code(result.rowCount ? 204 : 401).send();
  });
  app.post<{ Body: { title: string } }>(
    "/api/v1/content",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["title"],
          properties: {
            title: {
              type: "string",
              minLength: 1,
              maxLength: 250,
              pattern: "\\S",
            },
          },
        },
      },
    },
    async (req, reply) => {
      const owner = await principal(req);
      if (!owner) return reply.code(401).send();
      const record = await db.transaction(async (tx) => {
        const result = await tx.execute<{ id: string; title: string }>(sql`
        INSERT INTO content(owner_id,title) SELECT ${owner}::uuid,${req.body.title.trim()}::text
        WHERE EXISTS (SELECT 1 FROM user_roles u JOIN role_permissions p USING(role)
          WHERE u.user_id=${owner} AND p.permission='content.create') RETURNING id,title`);
        const content = result.rows[0];
        if (content)
          await tx.execute(sql`INSERT INTO audit_logs(actor_id,event,resource_id)
        VALUES(${owner},'content.created',${content.id})`);
        return content;
      });
      return record ? reply.code(201).send(record) : reply.code(403).send();
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/content/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
          required: ["id"],
        },
      },
    },
    async (req, reply) => {
      const user = await principal(req);
      if (!user) return reply.code(401).send();
      const result = await db.execute(sql`
      SELECT c.id,c.title FROM content c WHERE c.id=${req.params.id}
      AND (c.owner_id=${user} OR EXISTS (
        SELECT 1 FROM content_entitlements e LEFT JOIN subscriptions s ON s.id=e.subscription_id
        WHERE e.content_id=c.id AND e.user_id=${user} AND (e.ends_at IS NULL OR e.ends_at>now())
        AND (e.subscription_id IS NULL OR (s.starts_at<=now() AND s.ends_at>now()))))`);
      return result.rows[0] ?? reply.code(404).send();
    },
  );
  app.register(async (scope) => mediaRoutes(scope, pool, inputDir, principal));
  registerStudio(app, pool);
  return app;
}
