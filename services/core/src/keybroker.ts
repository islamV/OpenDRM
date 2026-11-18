import Fastify from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { openPool } from "./database.js";
import { parseKek, unwrapMediaKey, wrappingKeyRef } from "./media-crypto.js";

const secret = process.env.KEYBROKER_TOKEN;
if (!secret || !/^[a-f0-9]{64}$/.test(secret)) throw new Error("Missing broker credential");
const hash = (value: string) => createHash("sha256").update(value).digest();
const credential = hash("Bearer " + secret);
const kek = parseKek(process.env.MEDIA_KEK);
const pool = openPool(process.env.DATABASE_URL);
const app = Fastify({bodyLimit:1024, logger:false});
app.addHook("onSend",async (_req,reply) => { reply.header("Cache-Control","no-store"); });
app.setErrorHandler((_err,_req,reply) => { reply.code(400).send(); });
app.get("/health", async (_req,reply) => {
  try { await pool.query("SELECT kid FROM key_versions LIMIT 0"); return {status:"ready"}; }
  catch { return reply.code(503).send(); }
});
app.post<{Body:{jobId:string;kid:string}}>("/unwrap", {
  onRequest: async (req,reply) => {
    if (!timingSafeEqual(credential,hash(req.headers.authorization ?? ""))) return reply.code(401).send();
  },
  schema:{body:{type:"object",required:["jobId","kid"],additionalProperties:false,
    properties:{jobId:{type:"string",format:"uuid"},kid:{type:"string",format:"uuid"}}}}
},async (req,reply) => {
  try {
    const result = await pool.query(`SELECT v.kid,v.ciphertext,v.nonce,v.tag,v.wrapped_dek AS "wrappedDek"
      FROM packaging_jobs j JOIN encryption_keys k ON k.id=j.key_id
      JOIN key_versions v ON v.key_id=k.id AND v.version=j.key_version
      WHERE j.id=$1 AND j.state='completed' AND k.revoked_at IS NULL
        AND v.kid=$2 AND v.wrapping_key_ref=$3`,[req.body.jobId,req.body.kid,wrappingKeyRef]);
    const record=result.rows[0];
    if (!record) return reply.code(404).send();
    const key=unwrapMediaKey(kek,record,record.kid);
    try { return {k:key.toString("base64url")}; } finally { key.fill(0); }
  } catch { return reply.code(503).send(); }
});
app.addHook("onClose",async()=>{kek.fill(0); await pool.end();});
for (const signal of ["SIGINT","SIGTERM"]) process.once(signal,()=>{void app.close()});
await app.listen({host:"0.0.0.0",port:3100});
