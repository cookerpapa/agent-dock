# ADR-0041: Remove the cumulative per-Run token budget

- Status: Accepted
- Date: 2026-07-22
- Amends: ADR-0033

## Context

ADR-0033 introduced both per-Run and tenant-period token admission limits. In a
multi-step coding Run, every model request includes the restored conversation
and tool history. Provider usage therefore reports many of the same cached
prompt tokens again on later Agent Loop iterations. Summing those values into a
single per-Run token cap makes a healthy coding task fail simply because it
needed another tool/result round trip.

A production counting-sort Run demonstrated the problem. Five successful model
requests and five successful Tool Calls accumulated 173,623 reported tokens,
mostly repeated cache-read context. The sixth request was rejected before
provider egress because its reservation would exceed the 200,000-token Run cap.
The provider, network and isolated Tool runtime were healthy, but the user saw the
generic terminal failure `Model request failed` and the uncommitted Workspace
changes were discarded.

The platform already has controls that bound the same execution without making
repeated context an arbitrary correctness limit: model-request count, per-Run
cost, Tool Call count, Tool output size, wall-clock duration, tenant daily
tokens and tenant monthly cost.

## Decision

1. AgentDock no longer configures or enforces a cumulative token limit for one
   Run.
2. The trusted Model Gateway continues to record all provider-reported input,
   output, cache-read and cache-write tokens. These values remain visible in
   usage and cost accounting and continue to count toward the tenant daily
   token budget.
3. Per-Run model-request and cost limits remain enforced before provider
   egress, as do Tool Call, Tool output and wall-clock limits outside the Model
   Gateway.
4. Pi compaction reserve and recent-context settings remain independently
   bounded configuration. They are not constrained by a cumulative Run token
   budget because they describe one model context window, not total usage
   across Agent Loop iterations.
5. The obsolete database column, public governance field and Supervisor budget
   snapshot field are removed. The API must reject rather than silently ignore
   the old field through its existing closed schemas.
6. Existing `model_requests` and `usage_ledger` history is retained unchanged.
   Historical `run_token_budget` denial rows remain valid audit evidence, but
   new Gateway reservations can no longer produce that denial code.

## Consequences

- A coding Run can continue across multiple model/tool iterations without
  failing solely because repeated context crossed a cumulative token counter.
- Operators can still bound one Run by request count, cost and duration, and can
  bound tenant consumption by daily tokens and monthly cost.
- A zero-priced model configuration makes the per-Run cost cap ineffective, so
  deployments that require monetary governance must configure real rates. The
  request-count and duration limits remain effective regardless of price.
- Clients and persisted policy rows require a coordinated schema migration;
  there is no compatibility alias for `maximumTokensPerRun`.

## Rejected alternatives

### Increase the default from 200,000

Any fixed cumulative value retains the same failure mode for a longer Run and
does not distinguish novel context from provider-reported cache reuse.

### Exclude cache-read tokens only

That would make the counter less aggressive but would still couple Agent Loop
correctness to cumulative provider accounting. Cache reads remain relevant to
tenant quota and cost and should stay in those ledgers.

### Remove every token-related guard

Tenant daily token admission is still useful for shared-capacity governance and
is independent of whether one legitimate Run needs several iterations.
