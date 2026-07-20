# ADR-0034: Observability and reproducible evaluation

Status: accepted, 2026-07-20.

## Context

Run state, model usage, sandbox policy, and Workspace versions are durable, but
database rows alone do not explain latency across the asynchronous service
boundary. Ad-hoc demonstrations also cannot support a résumé claim: model
quality, durable orchestration, sandbox isolation, and HTTP capacity are
different questions and need different experiments.

Tenant IDs are useful for authorization and billing, but are high-cardinality
and sensitive labels. Prompt, tool output, source, credentials, and bearer
capabilities must never enter operational metrics or logs.

## Decision

1. Every Run owns one stable, non-zero 128-bit `trace_id` at durable acceptance.
   Attempts become virtual W3C parent spans, and the current carrier crosses
   Control Plane dispatch, trusted Runner, Model Gateway, Tool RPC, and Sandbox
   Manager HTTP boundaries.
2. OpenTelemetry exports OTLP/HTTP to Jaeger when configured. A no-export
   provider still creates valid local context in tests and development.
3. Each trusted service exposes a separate bearer-protected Prometheus endpoint.
   Metric labels are closed, low-cardinality sets; they never include tenant,
   Session, Run, prompt, path, or error text.
4. Operational logs are structured JSON, include trace/span identity when
   active, and recursively redact credential-like keys. Product-facing tenant
   aggregates come from an owner-only, tenant-scoped PostgreSQL API instead of
   exposing the global metrics store.
5. The private Compose deployment includes Prometheus, Jaeger, Grafana, and one
   loopback-only observability proxy. Backends remain on an internal network;
   only the proxy joins a separate non-platform edge network.
6. Evaluation is split into explicit scopes:

   - deterministic full Agent Loop coding tasks using the fake model;
   - deterministic targeted infrastructure fault injection;
   - live Docker Provider isolation and Pi remote-tool checks;
   - 10/50/100 simultaneous Control Plane Session/API load;
   - the disposable production acceptance test with live service restarts.

   Reports state what they do not measure. In particular, the HTTP load report
   does not claim 100 concurrent model/sandbox Runs, and the scripted coding
   suite does not claim model-intelligence quality.

## Consequences

- A Run can be located in Jaeger from its durable `traceId`, including retries.
- Prometheus and the provisioned Grafana dashboard expose platform saturation
  without leaking tenant content into labels.
- Deterministic reports can be regenerated without tokens or provider drift;
  real-model evaluation remains a separate opt-in experiment.
- Metrics are process-local and reset with a process. Durable cost and usage
  authority remains PostgreSQL.
- The local benchmark is evidence for this host/configuration only. It is not
  an Internet-scale or multi-region capacity claim.
