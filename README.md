# OpenShield DRM

OpenShield is a self-hosted video protection project. Through Phase 3, a publisher can upload MP4 video, inspect a packaging job, and generate a new encrypted edition. A private worker packages DASH and HLS with Shaka Packager. Playback licenses and client SDKs begin in later phases.

**[دليل السيرفر التفاعلي بالعربي](docs/server-guide-ar.html)** — download the HTML file and open it in a browser for installation, SSH access, upload, rotation and recovery commands.

## Start the local stack

Requires Linux, Docker Compose, Python 3 and Git. Clone the `openshield` branch. Run the same two commands on a fresh installation and when upgrading an existing Phase 2 checkout. The setup script preserves existing secrets and adds missing ones.

```sh
sh infrastructure/setup-media.sh
docker compose up -d --build --wait
curl --fail http://127.0.0.1:18321/health
```

Keep a private backup of the entire .env, database and media volumes. MEDIA_KEK wraps keys for every existing package. On mounts that ignore Unix mode bits, link .env to a private file on a Linux filesystem before running setup.

The API publishes only on loopback. Change API_PORT in .env if needed. Database access stays on the Compose network. Use `docker compose down` to stop the stack while preserving its data.

## Exercise the API

Run the following in a private shell with jq installed. Provisioning prints a credential once. Keep it on a trusted backend.

```sh
base=http://127.0.0.1:18321
credential=$(docker compose run --rm --no-deps -T migrate node dist/provision.js publisher | jq -er .credential)
token=$(curl -fsS -X POST -H "Authorization: Bearer $credential" "$base/api/v1/auth/token" | jq -er .token)
content=$(curl -fsS -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d '{"title":"Training film"}' "$base/api/v1/content" | jq -er .id)
curl -fsS -H "Authorization: Bearer $token" "$base/api/v1/content/$content"
curl -fsS -X POST -H "Authorization: Bearer $token" "$base/api/v1/auth/validate"

```

Use the viewer role for read-only identities. Entitlements are operator-managed database records in this phase. The access-token endpoint permits ten exchanges per minute per source IP. Session expiry is 900 seconds.

## Package and rotate a video

Use an active publisher token and a content ID owned by that publisher. Upload raw H.264 MP4 with optional AAC, up to 128 MiB. The API streams the source to a private input volume. A 202 response acknowledges the job. Check its terminal state to see whether the worker accepted the media.

```sh
upload=$(curl -fsS -H "Authorization: Bearer $token" -H 'Content-Type: video/mp4' \
  --data-binary @lesson.mp4 "$base/api/v1/content/$content/assets")
job=$(echo "$upload" | jq -er .jobId)
asset=$(echo "$upload" | jq -er .assetId)
curl -fsS -H "Authorization: Bearer $token" "$base/api/v1/jobs/$job"
# After the first job completes, create a new edition with a fresh key.
curl -fsS -X POST -H "Authorization: Bearer $token" "$base/api/v1/assets/$asset/rotate"
```

When the jobs have finished, close the operator session:

```sh
curl -fsS -X DELETE -H "Authorization: Bearer $token" "$base/api/v1/auth/session"
unset credential token
```

Manifest paths in job responses are private storage paths relative to /media/output inside the worker. Phase 3 stores the source and previous encrypted editions for repackaging and recovery. The HTTP surface exposes job status and metadata. Licensing, CDN delivery, segment-level live key rotation, transcoding, adaptive bitrate ladders and native device verification are later work.

## Develop and test

Use Node 22.12+ and PostgreSQL 16. Set TEST_DATABASE_URL to a dedicated, disposable PostgreSQL database with schema-owner rights. Tests apply migrations and insert fixture rows. DATABASE_URL identifies the database for local migrations, provisioning and the server.

```sh
npm ci --ignore-scripts
npm test
npm audit
npm run migrate
npm start
```

The server entrypoint uses 127.0.0.1:3000 outside Compose. Build output lives in dist. The workspace service owns runtime dependencies. Migrations are append-only. Each applied migration stores a checksum and concurrent migration runs serialize. Integration tests use Node's test runner, actual PostgreSQL transactions and Fastify's HTTP injection API.

## Project records

- [Repository audit and executed upstream commands](REPOSITORY_AUDIT.md)
- [Security findings and remediation](SECURITY_AUDIT.md)
- [Architecture and trust boundaries](ARCHITECTURE.md)
- [Phase plan and acceptance gates](IMPLEMENTATION_PLAN.md)
- [Arabic interactive server guide](docs/server-guide-ar.html)
- [OpenShield verification record](docs/VERIFICATION.md)
