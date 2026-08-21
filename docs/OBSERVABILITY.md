# Observability

## Run trace

The Control Plane assigns a stable W3C trace ID in the same transaction that
accepts a Run. Dispatch creates an Attempt parent and propagates `traceparent`
through the trusted Runner, Pi provider request, Tool RPC, Tool Broker, and
Sandbox Provider operations. The upstream model provider does not receive the
platform-internal trace header.

The principal span sequence is:

```text
run.dispatch
  -> run.execute
     -> model.request
     -> sandbox.create
     -> tool.execute/read/write
     -> sandbox.capture
     -> sandbox.stop
```

Run detail returns `traceId`. Observability is an optional production profile:

```bash
npm run production:up:observability
```

When enabled, Jaeger is available at `http://127.0.0.1:16686` and retains its
Badger store in a named volume. The core profile leaves OTLP export disabled,
unless an external endpoint is configured explicitly.

## Metrics

Prometheus scrapes four bearer-protected endpoints over the internal
observability network:

| Service | Internal endpoint | Main signals |
| --- | --- | --- |
| Control Plane | `control-plane:9464/metrics` | Turn admission, tenant quota-lock wait, queue, outcomes, process |
| Trusted Runner | `supervisor-host:9465/metrics` | Run, model, sandbox, checkpoint, process |
| Tool Broker | `tool-broker:9466/metrics` | Provider lifecycle, tools, process |
| Live Stream Compactor | `event-retention:9468/metrics` | PostgreSQL hot-tail deletion/replay-floor signals |

`pi_cloud_sandbox_active{provider="cubesandbox"}` reports assigned and
exact-Session warm Cube activations. Provider lifecycle, warm reuse and cleanup
are also visible through Run/Tool spans and Cube reconciliation logs.

The bearer token is generated under the private runtime directory and mounted
read-only. It is not the user API token. Prometheus is available through the
loopback proxy at `http://127.0.0.1:9090`.

The `PiCloud Platform` Grafana dashboard at `http://127.0.0.1:3001` contains
active/queued Runs, outcomes, p95 queue/Run/model/sandbox latency, token/cost,
tool failures, and process/resource panels. The administrator password is in
the runtime secret directory and is never printed by deployment commands.

## Product operational summary

`GET /v1/operations/summary` is owner-only and derives a tenant-scoped rolling
24-hour view from PostgreSQL. It includes Run success/retry counts, queue and
execution percentiles, model requests/tokens/cost, tool/test outcomes, active
sandbox assignments, and bounded failure categories. Members/viewers cannot
read it and a tenant can never select another tenant in the request.

## Privacy rules

- no tenant, Session, Run, prompt, path, repository, or exception message is a
  Prometheus label;
- logs recursively redact keys containing token, authorization, credential,
  password, secret, cookie, or API-key semantics;
- traces use opaque IDs and closed operation names; spans do not include prompt,
  tool output, file content, or credential values;
- durable usage/cost rows, not process metrics, remain billing authority.

## Verification

```bash
npm run production:deploy
npm run production:up:observability
npm run eval:coding -- --register
npm run eval:load
curl -fsS http://127.0.0.1:9090/-/healthy
curl -fsS http://127.0.0.1:16686/api/services
```
