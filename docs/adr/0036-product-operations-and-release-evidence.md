# ADR-0036: Product operations and release evidence

Status: accepted, 2026-07-20.

Amended by ADR-0037, which replaces the operator-oriented landing flow with
browser accounts and a conversation-first product shell. The current
CubeSandbox architecture also replaces the standalone Tool Sandbox image in
backup and release evidence with the Cube API authorizer, egress gateway and
immutable Cube Tool template.

## Context

The platform already exposes immutable Workspace versions, Run Attempts, test
results, usage, context, GitHub delivery, and operational aggregates, but the
browser previously exposed only conversation streaming. The deployment also
had documented backup advice without one executable, authenticated recovery
format, and CI did not produce image SBOM/vulnerability evidence.

Milestone 7 must close those product and operator loops without weakening the
trusted Runner/Tool Sandbox boundary or changing the owner's explicit decision
to keep the service private and loopback-bound.

## Decision

1. Add a Session inspector to the existing authenticated Web application. It
   uses only tenant-scoped public REST resources and renders Workspace history,
   files, structured compare results, Artifacts, Runs/Attempts, tests, usage,
   context, and owner operations. The browser receives no Pi JSONL, object-store
   credential, Docker access, or internal service capability.
2. Treat preview as inert evidence, not arbitrary application hosting. UTF-8
   files and Artifacts render as escaped text with a 256 KiB preview limit;
   binary content is labelled rather than executed. A future live preview needs
   a separate origin, content policy, network policy, lifecycle, and threat
   model.
3. Define product retry as submission of a new idempotent Run with the original
   loaded prompt. A terminal Run and its Attempts remain immutable; retry does
   not replay an old Run or claim exactly-once model/tool effects.
4. Expose an owner-only execution activity projection derived from immutable
   Run Attempt transitions, Workspace operations, model requests, and GitHub PR
   deliveries. This is tenant-scoped operational evidence, not a complete human
   actor audit: the existing rows do not record a user actor or request IP.
5. Add an offline coordinated backup format covering the private runtime,
   PostgreSQL, persistent Workspace storage, Worker/event WAL and optional
   observability state. Encrypt the compressed payload with
   AES-256-GCM and a scrypt-derived key; authenticate the format header; record
   hashes, Git revision, image version, and exact local image IDs. Restore only
   into a new empty project/runtime with matching images, verified paths and
   hashes. Never overwrite an existing deployment.
6. Extend the disposable production gate to stop a populated topology, create
   the encrypted backup, restore under a new Compose project, prove both tenant
   views/event history/Workspace operations survived, and complete a new Pi
   turn before exact cleanup.
7. Label every application image with OCI version/revision metadata. Generate a
   production-dependency CycloneDX SBOM plus one image CycloneDX SBOM and full
   HIGH/CRITICAL report per image. CI and the local release command reject any
   fixable HIGH or CRITICAL finding. Scanner images and third-party Actions are
   immutable-digest/commit pinned.
8. Keep Caddy and the observability ingress bound to host loopback. Bounded
   self-registration exists to validate tenant isolation from separate browser
   contexts; it is not an Internet-facing public demo or identity system.

## Consequences

- A user can inspect and operate the complete durable coding result without
  database, object-store, or Docker access.
- GitHub App repository selection and explicit PR delivery are available in the
  product, but remain disabled until an operator configures the App; contract
  tests are not described as a live GitHub installation.
- Recovery is intentionally cold and single-host. Larger deployments should
  replace raw volume archives with database/object-store native replication,
  but must preserve the same coordinated authority set.
- Backup confidentiality depends on the passphrase file. Losing either the
  backup or key is handled fail-closed; keeping both together defeats the
  encryption boundary.
- A zero-fixable-HIGH/CRITICAL gate is a release policy, not proof that an image
  has no lower-severity or currently unfixable risk. The complete HIGH/CRITICAL
  report remains evidence for review and patch planning.
- Public identity federation, abuse prevention, Internet ingress, dependency
  egress, arbitrary extensions, and live untrusted previews remain excluded.

## Evidence

- `npm run ci` includes protocol/Web/API tests and authenticated backup crypto
  tamper/wrong-key checks.
- `npm run production:check` exercises the product APIs, built Web bundle,
  encrypted seven-volume backup, clean restore, continued execution, and exact
  teardown.
- `npm run release:evidence` verifies clean revision-labelled images, emits
  checksummed SBOM/scan evidence, and applies the vulnerability gate without
  mounting the Docker socket into the scanner.
