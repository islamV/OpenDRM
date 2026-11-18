# Source security review

Scope covers both upstream Git trees identified in REPOSITORY_AUDIT.md. Findings below come from source and configuration inspection. Priorities assume an installation exposes the shipped service routes. Build failures limited runtime verification. The independent branch has separate code and a smaller attack surface.

| Priority | Boundary and source | Impact and remediation |
|---|---|---|
| Critical | Playback authorization, license-server/src/api/licenses.ts:18 and handlers/clearkey.ts:54 | Token validation is conditional and the key lookup lacks content entitlement checks. Require authenticated, scoped sessions and authorize every requested KID before returning any key. |
| Critical | Key service, license-server/src/index.ts:54 and grpc/server.ts:43 | Published gRPC uses insecure credentials. GetKey decrypts records without authenticating a worker or enforcing expiry/revocation. Isolate the endpoint, enforce mTLS, workload authorization and key lifecycle policy. |
| High | Administrative HTTP, license-server/src/api/routes.ts:26, api/auth.ts:18, api/keys.ts:12 | Mounted routes lack a mandatory administrator guard. Token claims come from the caller, and creation returns raw content keys. Separate publisher and playback identities, derive claims server-side and perform explicit permission checks. |
| High | Packager secret handling, packager-service/src/workers/packager.ts:69,123 | Key material enters command arguments and the debug logger. Keep workers isolated, use protected key input where supported, redact diagnostics and review retention. |
| High | Job/storage boundary, packager-service/src/api/jobs.ts:8, workers/packager.ts and storage/local.ts:17 | An unscoped caller chooses content identifiers and input paths that feed filesystem operations without confinement checks. Use generated storage IDs, authorized uploads, canonical path containment and process isolation. |
| High | Webhook destinations, license-server/src/api/webhooks.ts and services/webhook-service.ts:146 | Unrestricted caller-selected destinations create an outbound request boundary. Delivery persists response bodies. Require ownership, validate resolved destinations and redirects, limit egress and cap/discard response bodies. Missing migration tables currently obstruct this workflow on fresh installs. |
| High | Main deployment, docker-compose.yml | Known database and Grafana credentials accompany published ports. Generate separate secrets, remove public port mappings and restrict management access. |
| Medium | Provider proxies, api/licenses.ts:43 and handlers/{widevine,fairplay}.ts | Validating a signature alone does not authorize the content or device. Bind a validated session to the provider/content before forwarding and bound upstream time and payload size. |
| Medium | Key decryption, license-server/src/utils/crypto.ts:12 | Per-key synchronous scrypt blocks the event loop during license issuance. Limit request cardinality and use managed/versioned envelope encryption. |
| Medium | Client example, examples/react-integration.tsx:129 | A browser-side token helper accepts an administrative API key. Move credential-bearing operations to a trusted backend. |

## Dependency evidence

The critical advisories involved Vitest and Tinypool. The reported severity applies to the affected packages, including development tools. Reachability depends on how the tools are used. Update and lock dependencies, build all workspaces and verify imports before release. [Upstream scan](docs/UPSTREAM_ADVISORIES.md)

## OpenShield residual risks

The Phase 2 API uses high-entropy bootstrap credentials, short-lived digest-backed sessions, role checks and an entitlement query for metadata. The loopback development deployment uses HTTP. An operator with the bootstrap secret can mint additional sessions until the identity is disabled. Single-process rate limits do not coordinate across replicas. The database administrator remains trusted. Key material, packaging, license grants and provider credentials are outside the implemented HTTP surface. A production assessment must cover TLS, secret rotation, backup restoration, dependency and image scanning, durable abuse monitoring and physical-device playback.
