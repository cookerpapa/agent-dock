# ADR-0029: Trusted Pi runner and remote Tool sandbox

- Status: accepted, amended for CubeSandbox
- Date: 2026-07-20
- Extends: ADR-0027

## Context

Pi's Agent Loop and provider authentication are trusted control logic. Commands,
repository scripts and model-selected file operations are untrusted execution.
Putting both in one process would expose model credentials, Pi Session state and
platform authority to `bash`.

Pi supports registering replacement tools. The platform can therefore keep the
Pi SDK runtime in a trusted Worker and route `read`, `write`, `edit` and `bash`
through a narrow asynchronous Tool boundary, following the same trust split as
Pi's Gondolin example.

## Decision

1. Trusted Pi Workers own the embedded Pi SDK runtime, Pi-native Session JSONL,
   model calls and the Agent Loop. They never execute model-generated shell
   commands locally.
2. The Sandbox Manager owns logical activation, capability, lease and fencing
   checks. It exposes closed Tool schemas, not runtime-native handles.
3. CubeSandbox is the sole supported physical Tool execution plane. A Cube KVM
   guest receives `/workspace` and fixed toolchains, but no model, database,
   object-store, Control Plane, Kubernetes or Cube management credential.
4. The Pi tool adapter sends server-derived activation identity, a unique Tool
   call ID, bounded arguments and a deadline. The model cannot select a Cube,
   image, mount, network policy or resource shape.
5. Workspace paths are rooted and validated; command output, execution time and
   resources are bounded. Cancellation terminates the execution or destroys the
   Cube if process absence cannot be proven.
6. Tool capability rotation and monotonically increasing fencing tokens prevent
   an old RunAttempt from continuing to mutate durable Workspace state.
7. Conversation checkpoints and Workspace checkpoints are independent. A
   chat-only Run never activates Cube. A Tool Run commits through the fenced
   Workspace protocol before it becomes canonical.
8. Project/user Pi extensions remain disabled in the trusted Worker unless a
   separate isolation policy is introduced.

## Consequences

- Pi and model credentials stay outside the untrusted execution environment.
- Tool routing is independent of the Pi Worker process and physical Cube node.
- Cube lifecycle changes do not change Pi's Agent Loop contract.
- An arbitrary shell command remains at-most-once-start, not exactly-once.
