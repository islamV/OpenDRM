import { spawn } from "node:child_process";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { rmSync } from "node:fs";
import {
  writeFile,
  mkdir,
  mkdtemp,
  open,
  rmdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type pg from "pg";
import { openPool } from "./database.js";
import { parseKek, wrapMediaKey, wrappingKeyRef } from "./media-crypto.js";

const inputRoot = "/media/input";
const outputRoot = "/media/output";
const heartbeat = "/tmp/openshield-worker-heartbeat";
rmSync(heartbeat, { force: true });
async function heartbeatFor(milliseconds: number) {
  const temporary = heartbeat + ".tmp";
  await writeFile(temporary, String(Date.now() + milliseconds), {
    mode: 0o600,
  });
  await rename(temporary, heartbeat);
}
const kek = parseKek(process.env.MEDIA_KEK);
const pool = openPool(process.env.DATABASE_URL);
process.umask(0o077);
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
pool.on("error", () => console.error("Idle database session closed"));

type Job = { id: string; asset_id: string; content_id: string };
class MediaError extends Error {}

async function claim(client: pg.PoolClient): Promise<Job | undefined> {
  // Page past running jobs held by other workers, including after a worker died.
  let after: string | null = null;
  while (!stopping) {
    const page: pg.QueryResult<Job> = await client.query(
      `SELECT j.id, j.asset_id, a.content_id FROM packaging_jobs j
       JOIN content_assets a ON a.id=j.asset_id
       WHERE j.state IN ('queued','running') AND ($1::uuid IS NULL OR j.id>$1)
       ORDER BY j.id LIMIT 64`,
      [after],
    );
    for (const job of page.rows) {
      const locked = await client.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 929)) AS acquired",
        [job.id],
      );
      if (!locked.rows[0].acquired) continue;
      const changed = await client.query(
        "UPDATE packaging_jobs SET state='running',error_code=NULL WHERE id=$1 AND state IN ('queued','running')",
        [job.id],
      );
      if (changed.rowCount === 1) return job;
      await client.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 929))",
        [job.id],
      );
    }
    if (page.rows.length < 64) break;
    after = page.rows[63]!.id;
  }
}

function run(
  binary: string,
  args: string[],
  cwd: string,
  timeout: number,
  flagFd?: number,
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C" },
      stdio: ["ignore", "pipe", "ignore", flagFd ?? "ignore"],
      timeout,
      killSignal: "SIGKILL",
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout!.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 && bytes <= 256 * 1024)
        resolve(Buffer.concat(chunks).toString());
      else reject(new Error("Media tool failed"));
    });
  });
}

async function probe(path: string) {
  try {
    const result = await run(
      "ffprobe",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "mov",
        "-show_entries",
        "format=format_name,duration:stream=codec_name,codec_type",
        "-of",
        "json",
        path,
      ],
      inputRoot,
      30_000,
    );
    const info = JSON.parse(result) as {
      format?: { format_name?: string; duration?: string };
      streams?: { codec_type: string; codec_name: string }[];
    };
    const streams = info.streams ?? [];
    const video = streams.filter(
      (s) => s.codec_type === "video" && s.codec_name === "h264",
    );
    const audio = streams.filter(
      (s) => s.codec_type === "audio" && s.codec_name === "aac",
    );
    const duration = Number(info.format?.duration);
    if (
      !info.format?.format_name?.split(",").includes("mp4") ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      video.length !== 1 ||
      audio.length > 1 ||
      streams.length !== video.length + audio.length
    )
      throw new Error("Invalid stream selection");
    return audio.length === 1 ? ["video", "audio"] : ["video"];
  } catch {
    throw new MediaError("invalid_media");
  }
}

async function packageMedia(
  stage: string,
  path: string,
  tracks: string[],
  kid: string,
  key: Buffer,
) {
  const flagPath = join(stage, ".flags");
  const flags = await open(flagPath, "wx+", 0o600);
  try {
    // Unlink the empty inode before writing secrets. Shaka reads only the inherited fd.
    await unlink(flagPath);
    const rawKey = key.toString("hex");
    await flags.writeFile(
      "--keys=label=:key_id=" +
        kid.replaceAll("-", "") +
        ":key=" +
        rawKey +
        "\n",
    );
    await run(
      "packager",
      [
        ...tracks.map(
          (track) =>
            `in=${path},stream=${track},output=${track}.mp4,playlist_name=${track}.m3u8`,
        ),
        "--flagfile=/proc/self/fd/3",
        "--enable_raw_key_encryption",
        "--clear_lead=0",
        "--protection_scheme=cbcs",
        "--protection_systems=CommonSystem",
        "--hls_key_uri=urn:uuid:" + kid,
        "--mpd_output=manifest.mpd",
        "--hls_master_playlist_output=master.m3u8",
      ],
      stage,
      10 * 60_000,
      flags.fd,
    );
    const mpd = await readFile(join(stage, "manifest.mpd"), "utf8");
    const master = await readFile(join(stage, "master.m3u8"), "utf8");
    const manifests = [mpd, master];
    if (
      !mpd.includes('cenc:default_KID="' + kid + '"') ||
      !mpd.includes("<cenc:pssh>")
    )
      throw new Error("Missing DASH key signaling");
    for (const track of tracks) {
      const playlist = await readFile(join(stage, track + ".m3u8"), "utf8");
      manifests.push(playlist);
      const keys = playlist
        .split("\n")
        .filter((line) => line.startsWith("#EXT-X-KEY:"));
      if (
        !master.includes(track + ".m3u8") ||
        !(await stat(join(stage, track + ".mp4"))).size ||
        !keys.length ||
        keys.some(
          (line) =>
            !line.includes("METHOD=SAMPLE-AES,") ||
            !line.includes('URI="urn:uuid:' + kid + '"'),
        )
      )
        throw new Error("Missing HLS key signaling");
    }
    if (
      manifests.some(
        (text) =>
          text.toLowerCase().includes(rawKey) ||
          text.includes(key.toString("base64")),
      )
    )
      throw new Error("Unexpected key disclosure");
  } catch {
    throw new MediaError("packaging_failed");
  } finally {
    await flags.close();
  }
}

async function processJob(client: pg.PoolClient, job: Job) {
  const path = join(inputRoot, job.asset_id + ".mp4");
  const stageRoot = join(outputRoot, "." + job.id);
  // The parent directory belongs to this advisory-locked job. A crashed attempt
  // may have left partial files. Each child process uses a unique working directory.
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stageRoot, { mode: 0o700 });
  const stage = await mkdtemp(join(stageRoot, "attempt-"));
  const key = randomBytes(16);
  const kid = randomUUID();
  try {
    const tracks = await probe(path);
    await packageMedia(stage, path, tracks, kid, key);
    const sealed = wrapMediaKey(kek, key, kid);
    await client.query("BEGIN");
    try {
      // Reuse and lock the logical key, serializing version allocation across assets.
      const logical = await client.query(
        `INSERT INTO encryption_keys(content_id) VALUES($1)
         ON CONFLICT(content_id) DO UPDATE SET id=encryption_keys.id
         RETURNING id,revoked_at`,
        [job.content_id],
      );
      const logicalKey = logical.rows[0].id as string;
      if (logical.rows[0].revoked_at) throw new MediaError("key_revoked");
      const version = await client.query(
        `INSERT INTO key_versions(key_id,version,kid,wrapping_key_ref,wrapped_dek,ciphertext,nonce,tag)
         SELECT $1, COALESCE(MAX(version),0)+1, $2,$3,$4,$5,$6,$7 FROM key_versions WHERE key_id=$1
         RETURNING version`,
        [
          logicalKey,
          kid,
          wrappingKeyRef,
          sealed.wrappedDek,
          sealed.ciphertext,
          sealed.nonce,
          sealed.tag,
        ],
      );
      await client.query(
        `INSERT INTO packaging_outputs(job_id,format,manifest_path) VALUES($1,'dash',$2),($1,'hls',$3)`,
        [job.id, job.id + "/manifest.mpd", job.id + "/master.m3u8"],
      );
      await client.query(
        "UPDATE packaging_jobs SET state='completed',key_id=$2,key_version=$3 WHERE id=$1",
        [job.id, logicalKey, version.rows[0].version],
      );
      const dest = join(outputRoot, job.id);
      // A crash after rename and before commit leaves an unpublished directory.
      await rm(dest, { recursive: true, force: true });
      await rename(stage, dest);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } catch (error) {
    if (!(error instanceof MediaError)) throw error;
    await client.query(
      "UPDATE packaging_jobs SET state='failed',error_code=$2 WHERE id=$1",
      [job.id, error.message],
    );
  } finally {
    key.fill(0);
    await rm(stage, { recursive: true, force: true });
    await rmdir(stageRoot).catch(() => {});
  }
}

async function tick() {
  const client = await pool.connect();
  let job: Job | undefined;
  let broken = false;
  const lost = () => {
    broken = true;
  };
  client.on("error", lost);
  try {
    job = await claim(client);
    if (job) {
      // ffprobe and Shaka each have a deadline. Let the health probe distinguish
      // an active packaging run from a worker that stopped polling while idle.
      await heartbeatFor(12 * 60_000);
      await processJob(client, job);
    }
    await heartbeatFor(15_000);
    return Boolean(job);
  } catch (err) {
    broken = true;
    throw err;
  } finally {
    try {
      if (job && !broken)
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 929))",
          [job.id],
        );
    } catch {
      broken = true;
    }
    client.removeListener("error", lost);
    client.release(broken);
  }
}

try {
  const fingerprint = createHash("sha256").update(kek).digest();
  await pool.query(
    "INSERT INTO media_wrapping_keys(ref,fingerprint) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [wrappingKeyRef, fingerprint],
  );
  const registered = await pool.query(
    "SELECT fingerprint FROM media_wrapping_keys WHERE ref=$1",
    [wrappingKeyRef],
  );
  if (!timingSafeEqual(registered.rows[0].fingerprint, fingerprint))
    throw new Error("Wrapping key mismatch");
  while (!stopping) {
    try {
      if (!(await tick())) await delay(750);
    } catch {
      await rm(heartbeat, { force: true });
      console.error("Packaging queue unavailable, retrying");
      await delay(2000);
    }
  }
} catch {
  console.error(
    "Worker initialization failed. Check database access and MEDIA_KEK.",
  );
  process.exitCode = 1;
} finally {
  await rm(heartbeat, { force: true });
  kek.fill(0);
  await pool.end();
}
