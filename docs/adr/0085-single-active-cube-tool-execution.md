# ADR-0085: Single-active Cube Tool execution

- Status: Accepted
- Date: 2026-08-08
- Refines: ADR-0029, ADR-0053 and ADR-0080

## Context

Pi can execute sibling Tool calls in parallel. Production evidence previously
captured two `read` calls emitted 17 ms apart from one assistant response. The
Cube guest Tool Worker deliberately owns one active cancellable operation per
activation, so its second distinct request correctly returned
`tool_operation_overlap`.

This mismatch cannot be fixed by marking only `read` as parallel. Pi serializes
an entire sibling batch when any member declares sequential execution, while a
fully parallel batch can race reads with Workspace writes and cannot be
admitted by the current guest operation ledger.

## Decision

1. All production `read`, `write`, `edit` and `bash` definitions use Pi's
   public `executionMode: "sequential"` contract.
2. Model order is preserved before Tool RPC. The Cube Tool Worker retains one
   active operation, one cancellation controller and one terminal response at
   a time.
3. Retrying or reconnecting the same `operationId` is not parallel execution;
   it attaches to the existing recoverable ledger entry. A different operation
   arriving while one is active fails closed.
4. Parallel candidate evaluation remains a higher-level workflow using
   isolated Workspace branches and Cube activations. It does not weaken the
   single-activation Tool contract.
5. Tool parallelism may be reconsidered only after a measured implementation
   adds explicit concurrency admission to the Cube guest and proves ordering,
   cancellation, checkpoint quiescence and read/write consistency. Flipping Pi
   metadata alone is not an implementation.

## Consequences

- A model response containing sibling Tools no longer creates the user-visible
  `tool_operation_overlap` failure.
- Independent Runs and isolated candidate activations still execute in
  parallel; only Tools sharing one activation are serialized.
- Multiple independent reads may leave some theoretical latency improvement on
  the table. The current protocol chooses correctness and deterministic output
  over an unmeasured optimization.
- The execution-mode constant and extension test make this cross-layer contract
  visible in code and prevent an accidental one-line regression.

## Rejected alternatives

### Mark `read` parallel and keep writers sequential

Pi serializes the whole sibling batch when it contains any sequential Tool.
Read-only batches would still exceed the Cube Worker's one-operation admission
rule, so this does not safely improve current performance.

### Queue overlapping requests inside the Cube Tool service

That would merely duplicate Pi's ordering while complicating cancellation and
deadline semantics. Ordering belongs at the earliest trusted boundary.

### Allow every Tool to run concurrently

Concurrent Bash, edit and write operations can race Workspace contents,
background processes, output ordering and checkpoint freeze. The existing
Attempt, Step and Fencing identities do not by themselves make those effects
commutative.
