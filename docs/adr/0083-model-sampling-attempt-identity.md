# ADR-0083: Model sampling attempts within one Cloud Step

- Status: Accepted
- Date: 2026-08-08
- Refines: ADR-0034, ADR-0081 and ADR-0082

## Context

`CloudStepContext` identifies one logical provider-request boundary and the
Tool/world-state contract advertised by that boundary. A transient provider or
transport failure can retry the same request without any Tool execution or
world-state transition. Counting that retry as a new Step would falsely claim
that the execution world advanced and would make model-request accounting hard
to correlate with the Tool calls eventually produced by the successful sample.

The prior request ledger had a RunAttempt-local sequence but did not record the
Cloud Step digest. Public durable events likewise exposed model text and Tool
boundaries without the sampling identity that connected them.

## Decision

1. A normal Pi context boundary creates a new monotonically increasing Cloud
   Step. A Pi provider retry reuses that exact frozen Step and increments a
   separate positive `samplingAttempt`.
2. The trusted extension adds Step sequence, Step digest and sampling attempt
   headers to every Model Gateway request. The Gateway requires the headers,
   records them in `model_requests`, adds them to its trace span and enforces one
   request per `(Run, Attempt, Step, samplingAttempt)` identity.
3. Durable `model.sampling.started`, `model.sampling.completed` and
   `model.sampling.retry.scheduled` events expose bounded operational facts.
   Raw provider error payloads do not enter the public event log.
4. Tool boundary events inherit the Step/sampling identity of the assistant
   response that emitted them. Tool RPC continues to enforce the same Step
   digest independently at the Sandbox Manager.
5. Context-overflow compaction is not a transport retry. Because it changes the
   effective model context, the subsequent provider request captures a new
   Cloud Step.
6. Arbitrary Tool execution remains outside this retry mechanism. A Tool that
   started is recovered only by its existing operation identity; ambiguity is
   `UNKNOWN` and never creates a new execution.
7. Production enables Pi's public agent-level retry with at most two retries
   and 500 ms exponential-backoff base delay. Provider/SDK-level retry remains
   disabled because it would be invisible to Step identity, budgets and
   cancellation. Pi alone decides whether an assistant error is transient;
   context overflow continues through native compaction instead.

## Consequences

- A trace can distinguish logical Agent Loop progress from transport attempts.
- Every model attempt remains independently budgeted and auditable without
  multiplying Step/world-state entries.
- Cancellation can stop retry backoff without changing the Tool replay
  contract.
- A Run can contain multiple native Pi subturns. PiCloud emits one public
  `turn.started` boundary and accepts later non-overlapping `agent_start` /
  `agent_end` pairs until `agent_settled`.
- Historical model-request rows remain readable with a null sampling identity;
  all new Gateway requests require the complete identity.

## Rejected alternatives

### Allocate a new Step for every HTTP attempt

This confuses transport behavior with a changed model/Tool/world-state
boundary and needlessly advances the Sandbox Manager's Step watermark.

### Retry the complete RunAttempt

Once streaming or Tool execution has started, whole-Run replay can duplicate
visible output or side effects. Sampling retry is deliberately narrower.

### Store provider error text in durable events

Provider errors may contain request details and add little operational value.
The request ledger retains a bounded failure code while public events expose
only retry timing and identity.
