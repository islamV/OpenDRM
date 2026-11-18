# OpenDRM repository audit

Reviewed 18 November 2026. The full Git clone contained two branches. Main at `901176a0918480fbe14f6b806777ce20ca5c8a9c` contains 83 files. The Coolify branch at `088a4d1` adds four deployment files and shares all application code. Builds and generated files went into a disposable second checkout. The file-by-file inventory includes both trees. [Inventory](docs/UPSTREAM_INVENTORY.md)

## License decision

README line 281 links to LICENSE. Root package.json declares MIT and Python packaging declares an MIT classifier. Neither branch nor the reachable history contains the referenced license grant. GitHub reports a null license. The independent branch uses original implementation and documentation, its own MIT license, and no upstream source, assets or commit ancestry. Dependency metadata does not establish a grant for the application.

pnpm reported MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD, ISC, BlueOak-1.0.0, Python-2.0 and PSF labels. One dependency, dreamopt 0.8.0, had unknown license metadata. These observations cover the resolved Node packages. They do not establish redistribution clearance for Docker layers or external media binaries. [Versioned inventory](docs/UPSTREAM_DEPENDENCY_LICENSES.md)

## Execution log

| Command or check | Observed result |
|---|---|
| `git clone https://github.com/Dankular/OpenDRM.git` and `git ls-tree -r` | Full history retrieved, both branch trees inventoried |
| `npx pnpm@9.15.0 install --ignore-scripts` | Dependency resolution completed. Generated a local lockfile in the build checkout |
| `pnpm build` and `pnpm -r --no-bail run build` | Failed. License server emitted 47 TypeScript diagnostics and packager emitted six. SDK build completed |
| `CI=1 pnpm test` and recursive no-bail run | All three Vitest workspaces reported no test files and exited 1 |
| `node --input-type=module -e "import('@opendrm/player-sdk')"` within player package | Failed resolving dist/index.esm.js. Vite emitted index.js and index.cjs |
| `pnpm --filter @opendrm/license-server run db:migrate` against fresh PostgreSQL 16 | Succeeded. Observed keys, policies, content, license_requests and migrations. ORM also references three absent tables for API keys, webhooks and deliveries |
| `pnpm --filter @opendrm/license-server run db:seed` | Failed resolving absent src/db/seed.ts |
| `docker compose build license-server` | Built the final development stage. Compose omits a build target |
| `docker build --target production packages/license-server` on pristine tree | Failed at frozen pnpm install because no lockfile exists. Per-package context also lacks parent TS configuration and protocol source |
| `python3 setup.py --name` from sdks/python | Failed opening missing README.md |
| `php -l sdks/php/src/OpenDRM.php`, `bash -n sdks/curl/examples.sh`, `python3 -m compileall -q sdks/python` | Syntax checks passed. Go compiler unavailable on PATH |
| `pnpm audit --json` | 38 reported vulnerabilities across the resolved graph including build/test dependencies, with 3 critical, 14 high, 19 moderate and 2 low. No production reachability inference. [Advisories](docs/UPSTREAM_ADVISORIES.md) |

## Component findings

- **License service.** The HTTP server installs headers, CORS and rate limiting. API key validation and scope helpers exist without route enforcement. ClearKey checks key status/expiry, while ownership, session binding and device limits are missing. The external providers forward messages to configured URLs. The HTTP entrypoint lacks an octet-stream content parser for their binary request bodies. No authorized external provider or hardware workflow was exercised.
- **Storage and crypto.** Stored keys use AES-GCM with a per-record salt and synchronous scrypt against one environment secret. There is no versioned KEK identifier, independent wrapping provider or rotation workflow. Local and S3 adapters are present. GCS and Azure selectors throw. S3 imports an undeclared presigner, and its stream branch fails type checking.
- **Packaging.** BullMQ processes jobs and calls Shaka Packager. Job submission accepts an input path. Multipart registration alone supplies no upload/validation pipeline. Key selection is optional, track settings do not drive encoding, and the Widevine option sets a manifest flag without provisioning provider keys. HLS output metadata filters out MP4 even though the worker writes MP4. Playback, encrypted outputs and job recovery remain unverified.
- **SDKs and examples.** The web package includes Shaka, Video.js and an embed source. The Vite build entries omit the embed script. A successful bundling step still leaves a broken ESM import. Integration examples rely on an upstream application identity layer. PHP, Python, Go and curl clients wrap HTTP endpoints. Native Android/iOS projects, device tests and a management dashboard are absent.
- **Observability and events.** Both services expose Prometheus registries. Grafana provisioning, dashboards and alerts exist. The webhook test route dispatches to matching subscribers, while ordinary lifecycle call sites for dispatch are absent. A provisioned dashboard does not verify live metrics or license issuance.
- **Deployment.** Main Compose publishes databases, key services and monitoring ports. The Coolify variant removes default published data ports, supplies the full repository build context and bounds resource usage. It still builds the same failing application code, resolves packages without a lockfile and downloads a packager binary without a pinned checksum. Its deployment was reviewed statically.
- **Missing product workflows.** Subscription/ownership decisions, verified device registration, revocable playback sessions, watermarking, admin UI, media upload validation, key rotation, native playback and regression suites need independent implementations. See the phase plan for sequencing.

The source findings describe the reviewed revisions. The audit ran no requests against an external deployment, no key extraction and no proprietary DRM tests.
