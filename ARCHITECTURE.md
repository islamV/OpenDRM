# OpenShield architecture

Fastify, an isolated media worker and PostgreSQL form the development deployment. The operator uses a separate migration/provisioning process. Drizzle executes parameterized API queries and wraps multi-row writes in transactions. Raw SQL migrations use a dedicated PostgreSQL connection and transaction-scoped advisory lock.

```text
Operator -> migration/provisioning process -> PostgreSQL (schema owner)
Client   -> loopback Fastify API           -> PostgreSQL (shield_api role)
```

The operator provisions a viewer or publisher and delivers the one-time-displayed credential to the trusted caller. A credential exchange yields a random 256-bit session secret with a 15-minute lifetime. Only SHA-256 digests are persisted. Each protected request checks session expiry, revocation and account status. Publishers can create content. Reads require ownership or an explicit unexpired grant and an active subscription when the grant references one. Unauthorized reads of valid content IDs return 404. Content creation and its audit entry commit atomically.

The database models identity and permissions, assets and packaging jobs, versioned encrypted keys, policies, subscriptions, device and playback sessions, license decisions, audit records and security events. Foreign keys bind subscription grants to the same user. Active workflows include identity, catalog, private upload and asynchronous packaging. Key tables reserve separate fields for encrypted media keys, nonce, authentication tag and wrapped data key. The worker writes one version per completed package. The API role cannot read key versions.

The database volume persists across Compose restarts. Development setup creates the restricted API login before migrations grant privileges. Keep admin and runtime credentials separate. For a managed database provision the runtime role first and use a TLS connection string. Expired sessions can be purged after expiry. Before production, define audit/security retention consistent with the deployment's privacy policy, schedule archival and verify backup restores.

## Phase 3 media processing

The API streams each authorized upload to a server-generated path, syncs the file and inserts the asset, job and audit record in one database statement. Only a content owner with publishing permission can enqueue or rotate it. The API and worker share a private input volume. The output volume and wrapping secret are available only to the worker and server administrator. PostgreSQL holds the durable job queue for this single-host deployment. This avoids a second state store and a database-to-Redis handoff.

Each successful packaging run uses an independently generated content key and KID. A random data-encryption key protects the content key with AES-GCM. The local master key wraps the data-encryption key separately, with authenticated context. Each job records its logical key and version. Rotation repackages an asset into a separate edition, preserving earlier output. The source remains on disk for this purpose. Backups and disk encryption must cover the uploads as well as the database, encrypted output and KEK. A production KMS/HSM integration and automatic retention are future work.

Phase 4 introduces per-device playback sessions and scoped license authorization. Widevine and FairPlay require authorized providers and separate integration tests.
