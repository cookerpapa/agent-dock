# ADR-0042: Versioned project environment plane

- Status: Accepted
- Date: 2026-07-22

## Context

AgentDock currently executes every untrusted Tool Call in an operator-managed
Cube environment template. The guest image is isolated, but its identity is implicit:
projects do not own a durable environment version, Runs do not snapshot the
environment they were accepted against, warm Sandbox reuse only considers the
Workspace revision, and the platform does not retain evidence that the expected
toolchain was actually present inside the Sandbox.

That is sufficient for an infrastructure demo, but not for a cloud coding
product. A user must be able to tell which environment ran a task, an operator
must be able to roll out a new environment without changing an already accepted
Run, and a stale warm Pod must never be rebound after the project's environment
changes.

Allowing an Agent or browser client to submit arbitrary images, Dockerfiles,
Pod specifications, mounts, build secrets or egress policy would expand the
threat model substantially. Image building is privileged supply-chain work and
must not be confused with running project code in a restricted Tool Sandbox.

## Decision

1. Every Project owns an append-only sequence of environment versions. Exactly
   one version is active for new Runs.
2. Version 1 uses the operator-managed `agent-dock-fullstack` profile. The
   profile is immutable and identifies its expected Node.js, Java, Python and
   Git toolchain, the Tool Sandbox image revision and a canonical specification
   hash.
3. A Run snapshots the active environment version when its Turn is accepted.
   The snapshot crosses the durable outbox, Supervisor wire protocol and Tool
   Sandbox reservation. Later profile rollout cannot silently alter that Run.
4. The Sandbox Manager is the policy authority for the installed profile. It
   rejects a requested profile key, profile version, image revision or
   specification hash that does not exactly match its operator configuration.
   The model and browser never provide an image name, RuntimeClass, namespace,
   Pod name, mount, ServiceAccount or network policy.
5. Physical Cube activation remains lazy. Pure chat stores the environment
   snapshot but does not create a microVM. On the first real Tool Call, the Tool
   Worker compares the Run expectation with revision evidence baked into the
   physical image and performs bounded probes for the expected toolchain before
   becoming ready. A mismatch fails closed before project commands run.
6. The validated environment report is returned with Workspace capture and is
   persisted as append-only validation evidence tied to environment version,
   Run and Attempt. The environment version projection becomes `validated`
   only from this trusted report.
7. Warm Sandbox reuse requires an exact Workspace revision and exact
   environment identity. A different environment version, profile or image
   revision always receives a new Cube activation.
8. Provider metadata carries only non-secret environment identity for
   operations and audit. Tool Sandboxes remain credential-free and subject to
   the fixed Cube template, resource and network policy.
9. The public API and Web UI expose the project environment identity and latest
   validation evidence. Later backend-only recipe-management experiments were
   removed because they never formed a supported product workflow.

## Consequences

- Every accepted Run is reproducible at the environment-identity level and can
  be correlated with a concrete production image revision.
- Pure conversation keeps the lazy-Sandbox latency improvement because
  validation happens only on first Tool use.
- A production image rollout requires a new durable environment version before
  new Runs may target it. Existing Runs retain their old snapshot and fail
  closed if that image is no longer served by the Manager.
- A project cannot yet provide an arbitrary Dockerfile or install system
  packages. Adding that capability requires a separate trusted image-build
  plane, registry provenance, build-secret isolation, vulnerability policy and
  explicit dependency-network design.
- The first profile is deliberately broad enough for the product's current
  Python, Node.js and Java demonstrations. More profiles can be added through
  the same immutable contract without changing the Agent Runtime.

## Rejected alternatives

### Continue with one implicit image

This cannot prove which environment a Run used, makes rollouts overwrite
history, and lets warm Pod reuse ignore a correctness boundary.

### Let the Agent choose a Docker image

This turns model output into infrastructure policy, enables image supply-chain
attacks and bypasses the platform's reviewed Pod template.

### Run environment probes in the trusted Runner

That only verifies the Runner container. The evidence must come from the actual
Cube Tool Sandbox that executes untrusted project commands.

### Provision a Sandbox for every chat message

Environment identity is durable metadata and does not require physical
activation. Eager provisioning would reintroduce avoidable Sandbox cold
start latency for requests that never use tools.
