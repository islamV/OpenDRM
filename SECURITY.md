# Security

Report OpenShield issues to the project maintainer privately and include the affected commit and component. Redact access credentials, database URLs and media keys. This branch is a local development milestone. Review SECURITY_AUDIT.md for scope and outstanding deployment requirements.

Phase 3 keeps the source upload on a private Docker volume and runs ffprobe and Shaka in a separate unprivileged worker. Each media job uses a fresh KID and content key. The CLI receives key material through an unlinked inherited file descriptor. Packaging uses CBCS for shared fMP4 DASH/HLS media. Validate content, restrict operator access and protect original uploads and the wrapping key in backups. The local KEK provider trusts the host and worker. Use storage quotas and monitor free disk space before allowing production uploads. After a host crash or lost PostgreSQL response, reconcile input files with content_assets during a maintenance window before removing orphans.
