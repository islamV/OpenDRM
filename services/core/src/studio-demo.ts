import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { openPool, provision } from "./database.js";

const pool=openPool(process.env.DATABASE_URL);
const client=await pool.connect();
const base=process.env.API_INTERNAL_URL ?? "http://api:3000";
async function request(path:string,method:string,token:string,body?:string|Uint8Array<ArrayBuffer>,type?:string) {
  const response=await fetch(base+path,{method,body,headers:{authorization:"Bearer "+token,...(type?{"Content-Type":type}:{})}});
  if(!response.ok) throw new Error("Demo setup failed at "+path+" (HTTP "+response.status+")");
  return response.status===204 ? {} : response.json();
}
try {
  await client.query("SELECT pg_advisory_lock(1741167331)");
  const existing=await client.query("SELECT job_id FROM studio_demo");
  if(!existing.rowCount){
    const owner=await provision(pool,"publisher");
    const {token}=await request("/api/v1/auth/token","POST",owner.credential);
    try {
      const content=await request("/api/v1/content","POST",token,JSON.stringify({title:"Decision Engineering · Studio sample"}),"application/json");
      const bytes=new Uint8Array(await readFile(new URL("../docs/studio-sample.mp4",import.meta.url)));
      const {jobId}=await request("/api/v1/content/"+content.id+"/assets","POST",token,bytes,"video/mp4");
      let state="";
      for(let i=0;i<60;i++){
        state=(await request("/api/v1/jobs/"+jobId,"GET",token)).state;
        if(state==="completed"||state==="failed") break;
        await delay(1000);
      }
      if(state!=="completed") throw new Error("Sample packaging did not complete: "+state);
      const viewer=await provision(pool,"viewer");
      await client.query("BEGIN");
      await client.query("INSERT INTO content_entitlements(content_id,user_id) VALUES($1,$2)",[content.id,viewer.id]);
      await client.query("INSERT INTO studio_demo(job_id,viewer_id) VALUES($1,$2)",[jobId,viewer.id]);
      await client.query("COMMIT");
    } finally {await request("/api/v1/auth/session","DELETE",token);}
  }
  console.log("The public teaching sample is enabled at /player/.");
} finally {
  await client.query("ROLLBACK").catch(()=>{});
  client.release(true);
  await pool.end();
}
