import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";

const maxBytes = 128 * 1024 * 1024;
const params = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
};
const publisher = `EXISTS (SELECT 1 FROM user_roles r JOIN role_permissions p USING(role)
  WHERE r.user_id=c.owner_id AND p.permission='content.create')`;

export function mediaRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  inputDir: string,
  principal: (req: FastifyRequest) => Promise<string | undefined>,
) {
  app.addContentTypeParser("video/mp4", (_req, payload, done) =>
    done(null, payload),
  );
  app.post<{ Params: { id: string }; Body: Readable }>(
    "/api/v1/content/:id/assets",
    {
      schema: { params },
      bodyLimit: maxBytes,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const owner = await principal(req);
      if (!owner) return reply.code(401).send();
      if (req.headers["content-type"]?.split(";")[0]?.trim() !== "video/mp4")
        return reply.code(415).send();
      const owned = await pool.query(
        `SELECT 1 FROM content c WHERE c.id=$1 AND c.owner_id=$2 AND ${publisher}`,
        [req.params.id, owner],
      );
      if (!owned.rowCount) return reply.code(404).send();
      if (Number(req.headers["content-length"]) > maxBytes)
        return reply.code(413).send();
      const id = randomUUID();
      const name = id + ".mp4";
      const path = join(inputDir, name);
      const file = await open(path, "wx", 0o600);
      let keep = false;
      try {
        let length = 0;
        try {
          for await (const part of req.body.iterator({
            destroyOnReturn: false,
          })) {
            length += part.length;
            if (length > maxBytes) {
              req.raw.resume();
              return reply.code(413).send();
            }
            await file.writeFile(part);
          }
          if (!length) return reply.code(400).send();
          await file.sync();
        } finally {
          await file.close();
        }
        if ((await principal(req)) !== owner) return reply.code(401).send();
        // After dispatch the database may have committed even if its reply is lost.
        // Preserve the source in that case for recovery against content_assets.
        keep = true;
        const queued = await pool.query(
          `
        WITH asset AS (
          INSERT INTO content_assets(id,content_id,storage_path)
          SELECT $1,c.id,$2 FROM content c WHERE c.id=$3 AND c.owner_id=$4 AND ${publisher}
          RETURNING id
        ), job AS (
          INSERT INTO packaging_jobs(asset_id) SELECT id FROM asset RETURNING id,asset_id
        ), audited AS (
          INSERT INTO audit_logs(actor_id,event,resource_id) SELECT $4,'asset.uploaded',asset_id FROM job
        ) SELECT id AS "jobId",asset_id AS "assetId" FROM job`,
          [id, name, req.params.id, owner],
        );
        if (!queued.rowCount) {
          keep = false;
          return reply.code(404).send();
        }
        return reply.code(202).send(queued.rows[0]);
      } finally {
        if (!keep) await unlink(path);
      }
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/jobs/:id",
    { schema: { params } },
    async (req, reply) => {
      const user = await principal(req);
      if (!user) return reply.code(401).send();
      const found = await pool.query(
        `
      SELECT j.id,j.state,j.error_code AS "errorCode",
        COALESCE((SELECT json_agg(json_build_object('format',o.format,'manifestPath',o.manifest_path)
          ORDER BY o.format) FROM packaging_outputs o WHERE o.job_id=j.id),'[]') AS outputs
      FROM packaging_jobs j JOIN content_assets a ON a.id=j.asset_id JOIN content c ON c.id=a.content_id
      WHERE j.id=$1 AND c.owner_id=$2`,
        [req.params.id, user],
      );
      return found.rows[0] ?? reply.code(404).send();
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/assets/:id/rotate",
    { schema: { params } },
    async (req, reply) => {
      const user = await principal(req);
      if (!user) return reply.code(401).send();
      const result = await pool.query(
        `
      WITH owned AS (SELECT a.id FROM content_assets a JOIN content c ON c.id=a.content_id
        WHERE a.id=$1 AND c.owner_id=$2 AND ${publisher}), job AS (
        INSERT INTO packaging_jobs(asset_id) SELECT id FROM owned WHERE EXISTS (
          SELECT 1 FROM packaging_jobs j WHERE j.asset_id=owned.id AND j.state='completed')
        ON CONFLICT DO NOTHING RETURNING id
      ), audited AS (INSERT INTO audit_logs(actor_id,event,resource_id)
        SELECT $2,'asset.rotation_requested',$1 FROM job)
      SELECT owned.id,job.id AS "jobId" FROM owned LEFT JOIN job ON true`,
        [req.params.id, user],
      );
      if (!result.rowCount) return reply.code(404).send();
      if (!result.rows[0].jobId) return reply.code(409).send();
      return reply.code(202).send({ jobId: result.rows[0].jobId });
    },
  );
}
