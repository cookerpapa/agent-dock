# Demand-activated Sandbox latency evidence — 2026-07-21

## Scope

This report compares the production latency observed before ADR-0040 with a
real-provider, four-Run Session after revision `db70dd6`. The deployment used
the existing `deepseek-v4-flash` platform profile and the mandatory Kubernetes
`RuntimeClass/agent-dock-gvisor` (`runsc`/KVM) execution plane. It is a measured
single-host result, not a general provider benchmark.

Measured Session:

- project: `a492445c-db27-430e-b059-5d5e2a80d126`
- workspace: `38f4387f-7d76-45bb-9c97-d82f3ff930ee`
- session: `ab2a1f49-e9b2-4044-a77e-3a48ae9b14aa`

## Baseline and chat-only result

The pre-change production sample made no Tool Call but eagerly created/restored
a gVisor Pod. It reached the first visible text in about 6.68 seconds, completed
in about 13.4 seconds, emitted 152 text deltas, and spent about 3.9 seconds
draining events after model settlement.

| Measurement | Eager baseline | ADR-0040 chat-only | Change |
| --- | ---: | ---: | ---: |
| submit to first text | 6.68 s | 2.410 s | -63.9% |
| submit to terminal event | 13.4 s | 3.174 s | -76.3% |
| text delta events | 152 | 12 | -92.1% |
| post-production terminal persistence/SSE lag | ~3.9 s | 0.102–0.113 s | ~-97% |
| Tool Pods created | 1 | 0 | eliminated |

The first coalesced text event was produced at 2.359 seconds and reached the SSE
consumer at 2.410 seconds. The 51 ms difference includes the bounded publisher
window, PostgreSQL commit, notification and SSE replay path.

## Four-Run Session result

| Run | first text | terminal | events | Tool Calls | Pod result |
| --- | ---: | ---: | ---: | ---: | --- |
| chat, cold Session | 2.410 s | 3.174 s | 14 | 0 | no Pod |
| first coding Run | 2.075 s | 10.111 s | 27 | 4 | cold Pod created |
| second coding Run | 5.620 s | 6.479 s | 19 | 2 | same Pod rebound |
| chat after coding | 2.029 s | 2.843 s | 16 | 0 | Pod untouched |

The second coding Run's model latency is not directly comparable with the first
because the generated plans and Tool Call counts differ. The Tool timings below
isolate Sandbox activation from that model variance.

## Cold activation versus warm reuse

The first coding Run emitted two concurrent initial Tool Calls. Both shared one
Manager materialization promise. The first completion followed the starts by
3.704 seconds, which includes cold Pod scheduling, gVisor startup, Workspace
restore and operation execution. In the following Run, the first Bash completed
201 ms after `tool.started`.

The Kubernetes identity before and after rebind was:

```text
Pod:   agent-dock-tool-4ae2befb-0b02-43e2-88f9-0d751c144667
UID:   33b047a8-228a-44d6-bde1-f6f18da6b882
Run 2: fence=2, turn=0e8ddd90-8987-4157-8394-dc236f78545b
Run 3: fence=3, turn=06d21db2-3aa2-432f-9030-c7437d437693
```

The stable UID proves physical reuse; the changed Attempt/Turn annotations and
strictly newer fence prove that authority was rebound rather than carried over.
The file created in the cold Run remained present in the warm Run, and a direct
operator inspection still reported guest kernel `4.19.0-gvisor`.

The final chat Run created no Tool event and did not change the Pod's Turn,
Attempt, fence or UID. This proves that a warm Sandbox can coexist with a chat
Run without being touched by it.

## Event delivery result

Each event is still fsynced to the Supervisor spool before enqueue. Adjacent Pi
text deltas are coalesced in a 50 ms/2 KiB window, and the asynchronous
publisher batches bursts in one PostgreSQL transaction with one cumulative
ACK. The deterministic publisher test sends 100 queued events in two batches
of 64 and 36.

In this real provider sample, coalescing reduced the chat stream from 152 to 12
text events. Individual batches were often small because model chunks arrived
slower than the 20 ms batch window; correctness and latency do not depend on a
large batch. Across the four Runs, terminal production-to-persistence lag was
80–201 ms, versus roughly 3.9 seconds in the synchronous baseline.

## Verified invariants

- chat-only Run: zero Tool Pod and zero Tool event;
- concurrent first Tool Calls: one physical Pod;
- next coding Run: same Pod name and UID, higher fence and new Attempt;
- chat after coding: no rebind or Pod mutation;
- committed Workspace bytes survive the Run boundary;
- Tool guest remains gVisor/KVM;
- no error/exception/unhandled/failed entry appeared in the Control Plane,
  Supervisor Host or Sandbox Manager logs during the measurement.

These results support the narrow claim that the former latency came from eager
execution-environment lifecycle and synchronous event backpressure, not from a
need to weaken the gVisor boundary.

## Isolated production acceptance

The post-measurement production gate exposed two assumptions that had only
been invisible while every Run destroyed its Pod:

1. the Sandbox Manager's warm-Pod inventory returned internal lifecycle fields
   through a closed Supervisor protocol; the boundary now explicitly projects
   only the reviewed `SupervisorRuntimeAssignment` fields;
2. the cancellation fixture held the model request before any Tool Call and
   expected the old eager Pod to exist. It now emits a deterministic 300-second
   Bash call, waits for the `workspace` container to be Ready, and cancels an
   actually running gVisor workload.

The final disposable production acceptance passed after those fixes. It
proved that cancelling the long Bash removes only its own Pod and Lease, while
an unrelated completed Session retains its warm Pod. A subsequent Supervisor
generation change retired that retained Pod. The same assertions passed after
an encrypted backup was restored and the coding Session continued.

The accepted run recorded:

```text
durable events:          22
registered tenants:      4
Prometheus targets:      3
Jaeger services:          3
Workspace version:        3
product audit events:    31
encrypted backup bytes: 7,382,120
restored event cursor:   34
managed Pods after gate:  0
```

This acceptance is intentionally stronger than merely observing a fast chat:
it covers Control Plane reconnect and scale, fresh Supervisor boot, warm-Pod
inventory and retirement, active Tool cancellation, tenant isolation, event
replay, encrypted backup/restore, and post-restore continuation.
