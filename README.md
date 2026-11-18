# OpenShield DRM

Independent, self-hosted video protection project. This branch implements the database and core API through Phase 2. Operators can provision identities, issue and revoke sessions, and publish and authorize access to content metadata. Media ingestion, encryption and playback begin in later phases.

## Start the local stack

Requires Docker Compose and OpenSSL. From a fresh checkout, generate two hex passwords into a private environment file. Keep the file for subsequent starts because the database volume retains its roles.

```sh
(umask 077; set -C; { echo "DB_PASSWORD=$(openssl rand -hex 32)"; echo "API_DB_PASSWORD=$(openssl rand -hex 32)"; } > .env)
docker compose up -d --build
curl --fail http://127.0.0.1:18321/health
```

Check the permissions on the environment file. On mounts that ignore Unix mode bits, keep it on a private filesystem with mode 0600 and link .env to it or supply it with Docker Compose’s --env-file option.

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
curl -fsS -X DELETE -H "Authorization: Bearer $token" "$base/api/v1/auth/session"
unset credential token
```

Use the viewer role for read-only identities. Entitlements are operator-managed database records in this phase. The access-token endpoint permits ten exchanges per minute per source IP. Session expiry is 900 seconds.

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
- [OpenShield verification record](docs/VERIFICATION.md)
