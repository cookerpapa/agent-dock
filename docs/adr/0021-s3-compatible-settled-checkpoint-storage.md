# ADR-0021: S3-compatible settled checkpoint byte storage

- Status: accepted
- Date: 2026-07-19

## Context

ADR-0011 separates settled Pi/workspace bytes from PostgreSQL metadata and
defines checkpoint-before-terminal ordering, lease/fence validation, artifact
hashes, and revision compare-and-swap. Its first `CheckpointObjectStore`
implementation publishes immutable files in one private host directory. That
proves semantic cold restore but cannot restore a session after the next
Supervisor is scheduled on another host.

The database already stores provider-neutral logical object keys, SHA-256
digests, byte lengths, and the authoritative settled pointer pair. Replacing
those columns with S3 URLs or credentials would couple durable session metadata
to one deployment and would expose storage topology to the sandbox. The missing
piece is a remote implementation of the existing three-operation byte-store
interface.

S3 `PutObject` normally replaces an existing key, while the file adapter uses an
atomic hard link to enforce no-overwrite publication. The S3 adapter must retain
that immutability property. It must also bound response bodies rather than
trusting object metadata, because the object store is outside the PostgreSQL
fencing transaction and can be misconfigured or tampered with.

## Decision

1. Add `S3CheckpointObjectStore` as an implementation of the existing
   `CheckpointObjectStore` interface. `PostgresSandboxCheckpointStore`, artifact
   rows, session pointers, checkpoint revisions, and worker protocol do not
   change; no database migration is required.
2. PostgreSQL continues to store a logical relative object key. The adapter
   combines it with one deployment-configured bucket and optional key prefix.
   Bucket, region, endpoint, and credentials never enter database rows, public
   events, SSE, Docker arguments, sandbox environment, or checkpoint bytes.
3. The adapter validates the same closed object-key grammar as the file store.
   Bucket names use the general-purpose S3 DNS grammar. A configured prefix is
   also a validated relative key. Changing bucket or prefix without migrating
   existing objects is an operator error; the logical keys alone cannot locate
   a different namespace.
4. Uploads remain single-part because both checkpoint formats are bounded to at
   most 2 MiB. `PutObject` includes `If-None-Match: *`, exact content length, and
   a precomputed base64 SHA-256 checksum. An existing key fails closed instead
   of overwriting bytes. A concurrent S3 `409` is retryable; `412` means the
   supposedly fresh key already exists and is non-retryable.
5. Downloads request checksum metadata, reject invalid or oversized declared
   lengths, and consume the Node response stream through a second hard byte
   limit. The adapter verifies a returned SHA-256 checksum when present.
   `PostgresSandboxCheckpointStore` still verifies the downloaded bytes against
   the independent size/hash stored under the settled database pointer and then
   validates Pi JSONL/workspace structure.
6. Delete remains idempotent at the interface boundary and is used only for
   best-effort cleanup of objects whose metadata/CAS transaction failed. It does
   not delete the previous settled pair. Lifecycle-based garbage collection of
   older, successfully superseded checkpoints remains separate work.
7. SDK/network errors are translated into closed `SandboxCheckpointStoreError`
   codes and safe messages. Responses never include bucket, endpoint, key,
   access key, secret key, session token, or raw SDK error text. Network,
   throttling, and server failures are retryable; authorization, malformed
   configuration, missing objects, checksum failure, and immutable-key conflict
   fail closed.
8. AWS endpoints use normal SDK endpoint resolution. A custom S3-compatible
   endpoint defaults to path-style requests. Plain HTTP requires an explicit
   `allowInsecureEndpoint` option and is used only by localhost integration
   tests; production should use TLS and a private credential provider/role.
9. Bucket creation, versioning, encryption, lifecycle policy, replication, and
   IAM provisioning are deployment responsibilities. The runtime identity needs
   only `GetObject`, conditional `PutObject`, and cleanup `DeleteObject` on its
   configured prefix; it does not require list-bucket or bucket-admin access.
10. The executable compatibility proof uses two independently constructed
    adapters against one disposable localhost MinIO bucket. The writer is
    discarded before the reader restores the checkpoint, demonstrating that no
    process memory or host directory is required. The MinIO image is a pinned,
    digest-addressed test fixture and is not a production deployment
    recommendation.

## Failure boundaries

| Failure | Required outcome |
| --- | --- |
| first object succeeds, second upload fails | first object is best-effort deleted; no database pointer changes |
| both objects upload, metadata transaction fails | both fresh objects are best-effort deleted; old settled pair remains authoritative |
| object key already exists | conditional write fails and never replaces existing bytes |
| remote body exceeds declared/current limit | stream is aborted and no bytes are returned to restore |
| S3 checksum or database hash differs | restore fails as corrupt before Pi or workspace activation |
| writer process/host disappears after commit | a fresh adapter can load both objects using PostgreSQL logical keys |
| object store is unavailable before terminal | checkpoint ACK fails, so `turn.completed` is not published |
| old checkpoint becomes superseded | its bytes remain non-authoritative; later lifecycle GC may remove them |

## Consequences

- Settled sessions can move between Supervisor hosts without keeping a Pi
  process, container, or shared host filesystem alive.
- The control database keeps transactional authority while S3 supplies durable
  cold bytes; neither system alone can authorize a restore.
- Successful turns now depend on both PostgreSQL and object-store health before
  terminal publication, as already required by ADR-0011.
- Each checkpoint currently uses two small `PutObject` and two `GetObject`
  operations. Generic large repositories will require a separately specified
  archive/multipart format rather than weakening these bounds.
- Credential rotation and bucket migration remain deployment concerns because
  credentials are deliberately absent from durable session state.

## Rejected alternatives

### Store full `s3://` URLs in PostgreSQL

It couples every session pointer to one bucket/endpoint and complicates
credential, region, and namespace migration. Logical keys plus deployment
configuration preserve the existing provider-neutral contract.

### Let `PutObject` overwrite a UUID-derived key

UUID collision is unlikely but is not an immutability protocol. Conditional
write preserves the file adapter's fail-closed behavior and detects broken ID
generators or accidental key reuse.

### Trust ETag as the checkpoint digest

ETag is not a stable SHA-256 content hash and changes meaning for multipart or
encrypted objects. The existing database SHA-256 remains the recovery proof.

### Pass S3 credentials into the sandbox

Checkpoint bytes cross a private bounded worker channel to the trusted host.
Giving Pi/tool code object-store credentials would bypass policy, key prefix,
lease/fence, and terminal ordering boundaries.

### Use a shared host filesystem

It preserves host coupling, expands mount authority, and does not prove the
portable object-store interface needed by independently scheduled Supervisors.
