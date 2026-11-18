# OpenShield DRM

OpenShield lets publishers upload a video, package it into encrypted DASH and HLS, and produce a new edition with a fresh key. The current release covers private packaging and catalog access through Phase 3. Playback licenses, delivery of media to viewers and protected browser playback are planned.

This project lives on the **`openshield` branch** of this repository. The default `main` branch contains the upstream OpenDRM project with a different API and deployment.

### Interactive guides in Arabic

Download the HTML file using GitHub’s **Download raw file** button and open it in a browser. Both guides work offline.

- [دليل السيرفر](docs/server-guide-ar.html) — installation, SSH access, uploads, rotation, backups and recovery.
- [دليل الفرونت ومعاينة المشغّل](docs/frontend-player-ar.html) — try the player controls with an embedded unencrypted video, inspect viewer states and see how a web application connects to the backend.

## Start OpenShield

Use a Linux host with Git, Python 3, Docker Engine and Docker Compose. The setup script creates the database credentials and media wrapping key and preserves existing values on subsequent runs.

```sh
git clone --branch openshield --single-branch https://github.com/islamV/OpenDRM.git openshield-drm
cd openshield-drm
sh infrastructure/setup-media.sh
docker compose up -d --build --wait
base=http://127.0.0.1:18321
curl -fsS "$base/health"
curl -fsS "$base/api/v1/license/capabilities"
```

The default API bind is loopback. Set `API_PORT` in `.env` to change the published port and update `base` accordingly. The database, source videos and encrypted packages stay private. Back up `.env` and all three named volumes together. The worker needs the original `MEDIA_KEK` to recover the media keys. For filesystems that ignore Unix permissions, use the private-file symlink procedure in the server guide.

## What the capabilities response means

`GET /api/v1/license/capabilities` is a public discovery endpoint. This release returns HTTP 200 with the following body:

```json
{"clearkey":false,"widevine":false,"fairplay":false}
```

These flags describe **license issuance**. Encrypted packaging can finish successfully while all three flags are false. Use `GET /health` for API/database readiness and the job endpoint for a particular video.

**If you see “Route GET:/api/v1/license/capabilities not found”**, the API that handled the request has no matching route. OpenShield commit `45990bd` and its predecessors omitted this route. On an existing OpenShield checkout, inspect the branch and revision, then update and rebuild:

```sh
git status -sb
git log -1 --oneline
# On a clean openshield checkout:
git pull --ff-only origin openshield
sh infrastructure/setup-media.sh
docker compose up -d --build --wait
curl -i "$base/api/v1/license/capabilities"
```

If loopback gives 200 but the domain gives 404, compare the reverse proxy’s upstream host, port and forwarded path with the successful request.

## Publish a video

Run these examples in one private shell on the server with `jq` installed. Provision a publisher and exchange its credential for a 15-minute session. Store a long-lived publisher credential on a trusted backend.

```sh
publisher=$(docker compose run --rm --no-deps -T migrate node dist/provision.js publisher | jq -er .credential)
token=$(curl -fsS -X POST -H "Authorization: Bearer $publisher" "$base/api/v1/auth/token" | jq -er .token)
auth="Authorization: Bearer $token"
content=$(curl -fsS -H "$auth" -H 'Content-Type: application/json' \
  -d '{"title":"Training film"}' "$base/api/v1/content" | jq -er .id)
upload=$(curl -fsS -H "$auth" -H 'Content-Type: video/mp4' \
  --data-binary @lesson.mp4 "$base/api/v1/content/$content/assets")
job=$(printf '%s' "$upload" | jq -er .jobId)
asset=$(printf '%s' "$upload" | jq -er .assetId)
curl -fsS -H "$auth" "$base/api/v1/jobs/$job" | jq .
```

Supply an MP4 file named `lesson.mp4` containing H.264 video with optional AAC audio, up to 128 MiB. HTTP 202 acknowledges the queue submission. Poll the job until its state is `completed` or `failed`. On success, the output paths resolve inside the worker’s private `/media/output` volume. On failure, inspect `errorCode`.

After the first job completes, request rotation and follow the new job. The previous edition remains available in private storage.

```sh
rotation=$(curl -fsS -X POST -H "$auth" "$base/api/v1/assets/$asset/rotate" | jq -er .jobId)
curl -fsS -H "$auth" "$base/api/v1/jobs/$rotation" | jq .
curl -fsS -X DELETE -H "$auth" "$base/api/v1/auth/session"
unset publisher auth token
```

## HTTP API

| Method and path | Access | Purpose |
|---|---|---|
| GET /health | Public | API/database readiness |
| GET /api/v1/license/capabilities | Public | Discover available license systems |
| POST /api/v1/auth/token | Provisioned credential | Exchange credential for a session |
| POST /api/v1/auth/validate | Session | Check the current authenticated identity |
| DELETE /api/v1/auth/session | Session | Revoke the current session |
| POST /api/v1/content | Publisher session | Register content metadata |
| GET /api/v1/content/:id | Owner or entitled viewer | Read metadata |
| POST /api/v1/content/:id/assets | Publishing owner | Upload the raw MP4 and enqueue packaging |
| GET /api/v1/jobs/:id | Content owner | Read job status and output records |
| POST /api/v1/assets/:id/rotate | Publishing owner | Repackage a completed asset with a new key |

## Verify a change

Use Node 22.12+ and a dedicated PostgreSQL 16 database. Set `TEST_DATABASE_URL` to that disposable database with schema-owner rights. The suite applies migrations and creates fixture rows.

```sh
npm ci --ignore-scripts
npm test
npm audit
```

With the Compose stack running, `python3 tests/media-smoke.py` creates a test publisher and sample media, checks both encrypted output formats, rotates the asset, and checks invalid input and anonymous access. To stop the stack while retaining data, run `docker compose down`.

For development outside Compose, set `DATABASE_URL`, run `npm run build && npm run migrate && npm start`, and use the API on 127.0.0.1:3000. Full packaging requires the worker and its private volumes.

[Architecture](ARCHITECTURE.md) · [Implementation plan](IMPLEMENTATION_PLAN.md) · [Verification record](docs/VERIFICATION.md) · [Upstream repository audit](REPOSITORY_AUDIT.md) · [Security audit](SECURITY_AUDIT.md)
