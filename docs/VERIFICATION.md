# Phase 1 and 2 verification

Local run on 18 November 2026. The upstream execution record is in REPOSITORY_AUDIT.md.

| Command or probe | Result |
|---|---|
| npm ci --ignore-scripts and npm run build | Installed lockfile and compiled TypeScript |
| npm test against disposable PostgreSQL 16 | Six tests passed, zero failed or skipped. Covered repeated concurrent migrations, readiness, session exchange, expiry, revocation, permissions, entitlement expiry, audit persistence, rollback, disabled users, credential separation and rate limiting |
| npm audit | Registry returned zero known vulnerabilities in this resolution |
| docker compose up -d --build | PostgreSQL and API healthy, migration container exited 0 |
| HTTP GET /health on 127.0.0.1:18321 | 200, ready |
| Operator CLI, token exchange and publish with the restricted API database role | Account provisioned, token request 201, content create 201, owner read 200 |
| Live session revoke and validate | 204 followed by 401 |

The tests exercised metadata, access control and the development stack. They did not exercise video packaging, playback, third-party provider credentials, TLS termination, load limits across replicas or physical devices.

## Phase 3

The local Phase 2 Compose database was upgraded in place. The independent disposable PostgreSQL test database exercised clean migrations. The following checks ran with the Phase 3 code.

| Command / check | Observed result |
|---|---|
| npm test | TypeScript compiled and nine tests passed, including scoped upload and AES-GCM envelope round-trip and tampering cases |
| npm audit | Zero known vulnerabilities reported in the locked Node dependencies |
| docker compose up -d --build --wait | API, PostgreSQL and the private packaging worker started on this Linux x86-64 host |
| python3 tests/media-smoke.py | Generated an H.264/AAC MP4, uploaded it, inspected DASH PSSH/KID, HLS key tags and fMP4 encryption boxes, rotated the edition, verified its new KID and compared the original output byte-for-byte. Invalid media failed and anonymous requests were rejected |
| Second worker started with a different test MEDIA_KEK | Startup refused the fingerprint mismatch without changing the registered key |
| Offline HTML guide | Browser checks covered phone and desktop layout, settings validation, command generation, copy control and saved checklist |

Phase 3 uses private named volumes and a PostgreSQL-backed worker queue. Hardware DRM, content-key delivery to players, HSM/KMS integration and public playback remain outside these checks.

The server guide's cold backup and restore procedure was exercised between two disposable local Compose projects on separate loopback ports. The restored publisher authenticated, the original job and both manifest records matched, and all six package files matched their SHA-256 digests. The restored key envelope authenticated, and repackaging the restored input generated a new KID. The optional VPN, Caddy and remote VPS steps were not deployed.

## Self-hosted playback and Studio

- The Node.js suite passed 13 tests against PostgreSQL.
- Local Chromium acquired a usable ClearKey CDM key, presented 13 frames in 1.01 seconds and decoded AAC from the encrypted package. The manifest and license returned 200. Byte ranges for both tracks returned 206.
- The playback smoke test rejected missing credentials, missing or withdrawn entitlement, an unexpected KID, expired and revoked sessions and a revoked media key.
- A trusted tab blur paused the encrypted player and concealed the video. Refocusing kept the curtain closed. Explicit reveal remained paused until playback resumed.
- The operator-enabled protected sample acquired a real license. The standalone Studio HTML also played the embedded clear sample offline at mobile width.
