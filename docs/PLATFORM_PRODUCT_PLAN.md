# Platform product plan

## Positioning

AgentDock is a self-hosted Cloud Coding Agent platform, not a hosted CLI
process. Its differentiating project value is:

- durable and recoverable Pi Sessions;
- distributed Run scheduling;
- trusted Agent Loop/untrusted execution separation;
- CubeSandbox KVM isolation;
- versioned Workspace persistence;
- multi-tenant authorization and fencing;
- observable, reproducible failure and load evidence.

## User product

The ordinary product consists of:

```text
login/registration
  → conversations
  → named Workspace selection/creation
  → streaming Pi Agent interaction
  → committed directory/files/diff/artifacts
```

The platform administrator uses a separate settings product for model and Cube
network configuration.

## Platform layers

| Layer | Responsibility |
| --- | --- |
| Web | authentication, conversation and Workspace UX |
| Control Plane | tenancy, admission, state, idempotency, API |
| Temporal | durable Run orchestration and Worker matching |
| Pi Worker pool | Agent Loop, Pi Session restore, model events |
| Model Gateway | credential isolation and usage |
| Sandbox Manager | Tool authority, fencing, Cube lifecycle |
| Cube execution plane | untrusted bash/build/test processes |
| Data plane | PostgreSQL, object storage, Workspace checkpoints |
| Evaluation | correctness, security, failure and load evidence |

## Product invariants

- one normal active writer per Session;
- cold Sessions consume no dedicated Worker or Cube;
- pure chat creates no Cube activation;
- every Tool mutation is bound to the current Attempt/fence;
- browser transcript is not Pi recovery state;
- deleting a conversation does not delete a shared Workspace;
- tenant ownership is not platform administration;
- current production has one Sandbox runtime.

## Near-term priorities

1. finish and publish the Workspace-first product flow;
2. finish retention/orphan cleanup;
3. improve file/diff/test/artifact presentation;
4. add trusted Git delivery rather than exposing credentials to Cube;
5. publish capacity, latency and success-rate measurements;
6. deploy a reviewable demonstration environment when external exposure is
   intentionally approved.

## Resume evidence

Only implemented and measured statements should be used:

> Built a self-hosted multi-tenant Cloud Coding Agent on the Pi SDK, using
> Temporal for durable Run orchestration and CubeSandbox KVM microVMs for
> untrusted Tool execution. Implemented native Pi checkpoint restore,
> leased/fenced remote Tools, versioned Workspace checkpoints, resumable event
> streaming, capacity-aware Worker affinity and tenant-isolated product APIs.

Add concurrency, latency, token and security numbers only after the
corresponding live report is regenerated on the current commit.
