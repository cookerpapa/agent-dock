# ADR-0027: Platform-managed model credentials and brokered Pi execution

- Status: accepted, amended by ADR-0037
- Date: 2026-07-19
- Extends: ADR-0006 and ADR-0025

## Context

Each accepted Run fixes a provider, model, thinking level and credential
version. A long-lived provider key must never enter Pi's Session JSONL, a Cube
guest, a Workspace, Tool output, browser storage or public events.

The current browser product uses platform-managed model configuration. Operators
must be able to rotate the model and secret without restarting the Control Plane,
Pi Worker pool or Cube execution plane.

## Decision

1. The administrator configures only allowlisted provider/model combinations.
   Browser users cannot supply a base URL, provider key or arbitrary adapter.
2. Provider secrets are encrypted at rest with authenticated encryption and
   versioned metadata. Public/admin reads return safe configuration metadata,
   never plaintext, digests or encryption fields.
3. A Run snapshots the exact model/credential version at acceptance. Rotation
   affects later Runs and does not mutate already accepted work.
4. The trusted model boundary resolves and decrypts the configured version and
   issues a short-lived, Run-bound capability. Pi targets the internal
   OpenAI-compatible Model Gateway using only that capability.
5. The Gateway fixes upstream host, path and model; strips caller credentials;
   enforces body, timeout and request limits; streams the response; and records
   bounded usage without logging prompts or secrets.
6. Pi Workers can reach the Model Gateway but cannot reach the provider using a
   long-lived key. Cube Tool guests cannot reach the Model Gateway or receive
   either credential.
7. Hot configuration is read through the trusted configuration path and takes
   effect for new Runs without restarting the cluster.
8. Deterministic fake-model tests remain the normal zero-token verification
   path. Real-provider acceptance is explicit and bounded.

## Consequences

- Model-generated shell commands cannot read or spend the provider key.
- A compromised trusted model/credential boundary remains security-sensitive;
  multi-host production should back it with KMS/secret-manager identity.
- Credential backup and rotation must remain coordinated with PostgreSQL state.
- Tool isolation and model egress are independent policies.
