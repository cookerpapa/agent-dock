# ADR-0006: v0 product scope, model profiles, and credential ownership

- Status: Accepted
- Date: 2026-07-18

## Context

AgentDock ultimately targets reliable multi-user coding-agent execution, but a
first vertical slice cannot validate scheduling, sandboxing, recovery, Web UI,
multi-tenant authentication, arbitrary provider credentials, and a model
catalog at the same time. A model picker is visible product surface, but it is
not what makes Pi cloud-capable. The harder boundary is whether a browser turn
can be durably accepted, executed by a replaceable runner, streamed, settled,
evicted, and restored without tying the session to one process.

Pi can authenticate to OpenAI Codex through a user's ChatGPT subscription. That
OAuth flow produces a refreshable credential. It is useful for an explicit
local integration test, but a refresh token must not be copied into a session
record, Pi JSONL, workspace snapshot, browser payload, log, or untrusted agent
sandbox. Automated tests also must not silently consume subscription quota.

Hard-coding one provider and model throughout the domain would make later model
selection unnecessarily invasive. Accepting arbitrary provider/model strings
from a browser would create a different problem: unreviewed endpoints, missing
credentials, unpredictable cost, and sessions whose restored behavior differs
from the turn that originally ran.

## Decision

### Product boundary

The v0 vertical slice is a **single-user, self-hosted** Pi cloud runtime. One
owner opens a Web session, submits a turn, observes the AgentDock event stream,
and resumes the same conversation after the prior execution runtime has been
disposed. Multi-tenant identity, public signup, billing, fair tenant scheduling,
and a user-facing model picker remain later roadmap work.

This scope is an implementation milestone, not a change to the long-term
multi-user goal.

### Model profiles

The control plane owns an allowlisted `ModelProfile` concept. A profile contains
at least:

- an AgentDock profile ID;
- provider and model IDs understood by the pinned Pi version;
- an allowed/default thinking level;
- an opaque credential binding ID;
- enabled/disabled policy state.

The initial deployment exposes one operator-configured default profile. The Web
UI does not need a model picker. Clients never submit arbitrary provider
endpoints or raw credential material.

A session stores its desired model-profile ID. Every accepted turn stores an
immutable resolved snapshot containing provider, model, thinking level, and the
credential-binding version used for that turn. This makes audits and recovery
independent from later changes to the default profile. A model change is allowed
only between settled turns and becomes an explicit domain event; it never
silently mutates an in-flight turn.

### Credential ownership

Conversation state and credentials have separate lifecycles:

- PostgreSQL stores only opaque credential-binding metadata;
- Pi JSONL stores conversation/model history but no refresh token;
- workspace and object-store snapshots contain no provider credential;
- the browser never receives stored access or refresh tokens;
- the untrusted agent/tool environment never receives a long-lived refresh
  credential.

The target production path uses a trusted credential broker or model gateway to
refresh credentials outside the untrusted workspace and supply request-scoped
authorization to the execution boundary. The exact broker mechanism is deferred
until the sandbox/model path is implemented and threat-modelled.

During Phase 0, a local opt-in probe may read the owner's existing Pi agent
credential directory to verify the pinned SDK, real token accounting, JSONL
settling, and multi-turn rehydration. It must use a temporary workspace and
session directory, disable tools and extensions, redact credential values,
remove its transcript, and require an explicit quota-consumption flag. It is an
integration probe, not the production secret-distribution design.

Deterministic fake-model scenarios remain the default for CI and failure tests.
No default `check`, test, demo, or clean-checkout command may spend provider
tokens.

## Consequences

- The first Web experience can use one fixed model without blocking future
  model selection.
- Model choice becomes a policy/profile operation instead of a raw frontend
  string field.
- Restored turns can explain exactly which model configuration originally ran.
- ChatGPT subscription authentication is one credential adapter, not part of
  session identity or the definition of cloud execution.
- A secure credential broker remains required before the architecture can claim
  production-safe multi-tenant provider authentication.
- Live-provider validation stays useful but optional, cheap, and auditable.

## Rejected alternatives

### Build the model picker before the execution lifecycle

This demonstrates provider configuration but not durable cloud execution, and
it delays the higher-risk suspend/resume, ordering, cancellation, and isolation
work.

### Hard-code one model directly into sessions and turns

Simple initially, but it couples durable state to a deployment default and
makes later model policy and audit history a migration problem.

### Let clients submit arbitrary provider/model/base URL values

This bypasses operator policy and complicates credential, cost, egress, and
compatibility controls.

### Share one Pi `auth.json` across future tenants

This destroys credential isolation, makes attribution and revocation ambiguous,
and exposes a long-lived refresh credential to unrelated execution contexts.
