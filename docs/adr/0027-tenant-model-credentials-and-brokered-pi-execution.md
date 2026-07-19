# ADR-0027: Tenant model credentials and brokered Pi execution

- Status: accepted
- Date: 2026-07-19
- Extends: ADR-0006's credential-broker target and ADR-0025's tenant boundary

## Context

AgentDock already freezes the selected profile, provider, model, thinking level,
credential binding ID, and credential version when a turn is accepted. The
production Docker worker also runs the pinned Pi RPC process and its built-in
tools. Its model endpoint is still an embedded deterministic fake, however, and
the control plane stores only an opaque fake binding. A tenant therefore cannot
configure a real provider, and passing an API key directly to Pi would let any
shell tool or compromised worker read and reuse that long-lived secret.

This slice must support a real DeepSeek-backed Pi coding turn without weakening
the zero-token test path or claiming that the shared Docker daemon is a boundary
for mutually hostile Internet tenants.

## Decision

### Tenant configuration and encrypted storage

1. Add an authenticated model-configuration resource. Every role may read safe
   metadata; only a tenant `owner` may replace the provider credential or model.
   The API accepts one server-owned provider registry entry (`deepseek`) and an
   allowlisted model ID. It never accepts a caller-controlled base URL, protocol
   adapter, context size, or arbitrary provider name.
2. A replacement reuses the tenant's default model-profile and credential-binding
   identities but creates an immutable, monotonically increasing credential
   version. The profile is switched to that exact version in the same PostgreSQL
   transaction. Already accepted turns retain their earlier snapshot and remain
   executable; old versions are retained until a future explicit retention job
   proves they are no longer referenced.
3. Provider secrets are encrypted with AES-256-GCM before insertion into a new
   tenant-scoped table. The deployment master key is a private file mounted only
   by the control plane and Supervisor host. Ciphertext uses associated data that
   binds tenant ID, binding ID, binding version, provider, and key version. A
   SHA-256 digest supports content-idempotent replacement but is never returned.
4. API responses contain only provider, model, configuration state, credential
   version, and update time. Plaintext, digest, encrypted fields, `secret_ref`,
   master-key metadata, and gateway capabilities are not public resources or log
   fields. Browser input is held only long enough to submit the replacement and
   is then cleared; it is never persisted in browser storage.

### Brokered model egress

5. The trusted Supervisor resolves the exact tenant/binding/version snapshot,
   verifies its provider, decrypts it, and issues a random per-turn gateway
   capability. The capability is bound to command, tenant, turn, provider, and
   model; it has a short expiry and bounded request count/body size and is revoked
   when the Docker activation settles or is torn down.
6. Pi receives the capability as its runtime API key and targets an internal
   OpenAI-compatible gateway. The long-lived provider API key never enters the
   Docker message, arguments, labels, environment, workspace, Pi session,
   checkpoint, event stream, or tool output. A shell tool may discover the
   short-lived capability in its inherited process environment, so the gateway
   treats it as expendable and enforces all bindings independently of the caller.
7. A real-model worker joins exactly one Compose-internal model-runtime network.
   It has no direct egress network. Only the trusted Supervisor host joins both
   that internal network and a provider-egress network. Fake-model activations
   retain `--network none`, their embedded fake server, and zero-token behavior.
8. The gateway accepts only `POST /v1/chat/completions`, bearer authentication,
   bounded JSON, and the capability's exact model. It constructs the upstream URL
   and authorization header from the provider registry and decrypted credential,
   strips caller headers, enforces timeouts, forwards streaming responses, and
   never logs bodies or auth material. Provider usage reported in the stream is
   written to the existing tenant/turn usage ledger with zero cost until a
   separately versioned price table exists.

### Pi worker behavior

9. The Docker worker protocol becomes a closed union of `embedded_fake` and
   `openai_compatible_gateway`. Runtime configuration still travels over the
   container's authenticated stdin protocol, never Docker arguments or labels.
   The worker verifies that provider/model match the accepted turn and then uses
   the same pinned `PiRpcTurnRunner`, built-in `bash`/`edit` tools, checkpoints,
   durable event ACKs, cancellation, and bounded final Git diff in both modes.
10. The real path gets a longer but bounded model-request and turn timeout. CI and
    routine production acceptance never select a paid profile; a live-provider
    check is explicit because it incurs external cost and requires a tenant-owned
    secret.

## Executable acceptance criteria

This decision is complete only when automated tests and one explicit live test
prove all of the following:

1. owner configuration round-trips safe metadata, member/viewer replacement is
   denied, tenant B cannot observe tenant A's state, retries with identical secret
   and model do not create another version, and rotation does;
2. database rows contain authenticated ciphertext rather than plaintext, altered
   ciphertext/AAD fails closed, and a wrong deployment key cannot decrypt it;
3. model configuration accepts only the fixed provider/model registry and never
   a URL or extra secret-shaped field;
4. a fake turn still starts with `--network none`, while a real turn joins only
   the validated internal model network; no provider key/capability appears in
   Docker arguments, labels, public events, checkpoints, or logs;
5. unknown, expired, revoked, over-budget, wrong-model, and wrong-path gateway
   requests fail without reaching the provider;
6. a real DeepSeek request flows through
   `Web/API -> durable turn -> Supervisor -> Docker -> Pi -> gateway -> provider`,
   invokes Pi tools against the fixture, commits a settled checkpoint and final
   diff, and records positive token usage for the exact tenant and turn; and
7. the rebuilt loopback production topology remains healthy and the disposable
   zero-token production acceptance continues to pass.

## Consequences

- A tenant can now make the existing Pi sandbox a real coding agent instead of a
  scripted demonstration, while deterministic tests remain free and repeatable.
- The Supervisor becomes a trusted credential and egress boundary. A compromise
  there can expose tenant credentials; multi-host production should move this
  authority to a dedicated broker/KMS identity rather than copying the master
  key to untrusted workers.
- The deployment master key must be backed up with the database. Losing it makes
  stored provider credentials unrecoverable; rotating it requires an explicit
  re-encryption procedure not implemented in this slice.
- Provider cost is not inferred from mutable prices. Token counts are durable;
  monetary accounting remains zero until pricing versions and currencies are
  modeled explicitly.
- Existing fake-profile tenants remain usable. Configuring a real model is an
  intentional per-tenant operation and future turns will consume that tenant's
  provider quota until the profile is changed again.

## Rejected alternatives

### Put the provider API key in the Docker worker environment

Pi's built-in shell launches child processes from that environment. Any prompt
injection or tool command could print and exfiltrate a reusable tenant secret.

### Give every worker direct Internet access and a proxy URL

A URL is not an egress policy. Direct access would let tools bypass the model
gateway and make capability request/model bounds unenforceable.

### Store provider keys as plaintext or only in browser memory

Plaintext weakens backups and database compromise; browser-only keys cannot
support queued execution, server restart, or cold session restore.

### Remove the fake model path

That would make correctness/security acceptance depend on provider uptime and
would spend tenant quota during normal CI. The fake and paid paths intentionally
exercise the same Pi worker after runtime resolution.
