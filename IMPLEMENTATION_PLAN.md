# Implementation milestones

| Phase | Deliverable | Evidence or acceptance gate |
|---|---|---|
| 0 | Upstream license, code, build, tests, dependency and deployment audit | See repository and security audits, branch inventory and dependency tables |
| 1 | Independent Git history, Node workspace, MIT license, dependency lock, PostgreSQL development stack, non-root API container and CI definition | Clean install and TypeScript build, Docker Compose startup and health probe |
| 2 | Normalized PostgreSQL schema and grants, locked checksum migrations, operator provisioning, revocable sessions, role-based publishing, owner/entitlement reads and transactional audit events | Database integration tests and live HTTP session/content/revocation smoke |
| 3 | Upload, media validation, private storage, envelope encryption, key rotation and Shaka packaging | Local filesystem worker and versioned packaging implemented. Run tests/media-smoke.py against Compose for encrypted outputs, access checks and rotation. External object storage and KMS integration remain open |
| 4 | Device identity, session limits, revocation, short-lived playback tokens and license authorization | Exercise entitlement, KID, expiry and revocation decisions against PostgreSQL |
| 5 | Web SDK | Test authorized and denied browser playback on a packaged fixture |
| 6–7 | Android and iOS SDKs | Verify Media3 and AVPlayer on physical devices using supported profiles |
| 8 | Admin dashboard | Validate roles, catalog, job and device management |
| 9 | External providers | Validate Widevine and FairPlay exchanges against authorized provider credentials |
| 10 | Production hardening and deployment | TLS, backup restoration, retention, scans, security review and device matrix |
