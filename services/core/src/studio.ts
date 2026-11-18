import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type pg from "pg";
import { digest, newSecret } from "./database.js";

export function registerStudio(app:FastifyInstance,pool:pg.Pool) {
  app.get("/player",(_req,reply)=>reply.redirect("/player/"));
  app.get("/player/",async (_req,reply)=>{
    const nonce=randomBytes(18).toString("base64");
    const html=await readFile(new URL("../docs/frontend-player-ar.html",import.meta.url),"utf8");
    reply.header("Content-Security-Policy", [
      "default-src 'self'", "base-uri 'none'", "frame-ancestors 'self'",
      "script-src 'self' 'nonce-"+nonce+"'", "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:", "media-src 'self' blob: data:", "connect-src 'self' blob:",
      "worker-src 'self' blob:", "object-src 'none'", "form-action 'self'"
    ].join("; "));
    reply.header("Permissions-Policy","display-capture=(), camera=(), microphone=()");
    return reply.type("text/html; charset=utf-8").send(html.replaceAll("<script>",'<script nonce="'+nonce+'">'));
  });
  for(const [file, path, mime] of [
    ["player-live.js","../docs/player-live.js","application/javascript"],
    ["player-poster.webp","../docs/player-poster.webp","image/webp"],
    ["studio-sample.mp4","../docs/studio-sample.mp4","video/mp4"],
    ["shaka.js","../node_modules/shaka-player/dist/shaka-player.compiled.js","application/javascript"]
  ] as const) {
    app.get("/player/"+file,async (_req,reply)=>
      reply.type(mime).send(await readFile(new URL(path,import.meta.url))));
  }
  // Only the operator-seeded public sample can be requested here. The browser
  // receives a job-bound playback token and never sees the internal viewer login.
  app.post("/player/demo",{config:{rateLimit:{max:10,timeWindow:"1 minute"}}},async (_req,reply)=>{
    const login=newSecret();
    const selected=await pool.query(`WITH demo AS (SELECT d.viewer_id,d.job_id FROM studio_demo d
      JOIN users u ON u.id=d.viewer_id WHERE NOT u.disabled),
      created AS (INSERT INTO auth_sessions(user_id,token_hash,expires_at)
        SELECT viewer_id,$1,now()+interval '5 minutes' FROM demo RETURNING user_id)
      SELECT job_id FROM demo JOIN created ON created.user_id=demo.viewer_id`,[digest(login)]);
    if(!selected.rowCount) return reply.code(404).send({error:"Demo has not been enabled"});
    const issued=await app.inject({method:"POST",url:"/api/v1/jobs/"+selected.rows[0].job_id+"/playback",
      remoteAddress:_req.ip,headers:{authorization:"Bearer "+login}});
    return reply.code(issued.statusCode).type("application/json").send(issued.body || "{}");
  });
}
