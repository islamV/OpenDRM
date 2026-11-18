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
