import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PiCloudMetrics,
  activeTraceCarrier,
  operationalLog,
  parseTraceCarrier,
  startMetricsEndpoint,
  virtualRunTraceCarrier,
  withSpan,
} from "../src/index.ts";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

beforeAll(() => provider.register());
afterAll(async () => provider.shutdown());

describe("PiCloud observability primitives", () => {
  it("propagates one W3C trace across nested service spans", async () => {
    const root = virtualRunTraceCarrier("1".repeat(32), "2".repeat(16));
    let childCarrier;
    await withSpan({
      serviceName: "control-plane",
      name: "run.dispatch",
      parent: root,
      run: async () => {
        childCarrier = activeTraceCarrier();
        await withSpan({ serviceName: "agent-runner", name: "run.execute", run: () => undefined });
      },
    });
    expect(parseTraceCarrier(childCarrier)).toBeDefined();
    const spans = exporter.getFinishedSpans().slice(-2);
    expect(spans).toHaveLength(2);
    expect(new Set(spans.map((span) => span.spanContext().traceId))).toEqual(
      new Set(["1".repeat(32)]),
    );
    expect(spans.find((span) => span.name === "run.execute")?.parentSpanContext?.spanId).toBe(
      spans.find((span) => span.name === "run.dispatch")?.spanContext().spanId,
    );
  });

  it("exports authenticated Prometheus metrics without tenant labels", async () => {
    const metrics = new PiCloudMetrics("test-service");
    metrics.runs.inc({ outcome: "completed" });
    metrics.turnAdmissionDuration.labels("accepted").observe(0.012);
    metrics.tenantAdmissionLockWait.observe(0.003);
    metrics.eventDurabilityDuration.labels("success").observe(0.02);
    metrics.eventDurabilityGroupSize.observe(16);
    const endpoint = await startMetricsEndpoint({
      host: "127.0.0.1",
      port: 0,
      token: "m".repeat(32),
      registry: metrics.registry,
    });
    try {
      const denied = await fetch(`http://127.0.0.1:${String(endpoint.port)}/metrics`);
      expect(denied.status).toBe(401);
      const response = await fetch(`http://127.0.0.1:${String(endpoint.port)}/metrics`, {
        headers: { authorization: `Bearer ${"m".repeat(32)}` },
      });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain('pi_cloud_runs_total{outcome="completed",service="test-service"} 1');
      expect(body).toContain(
        'pi_cloud_turn_admission_seconds_count{service="test-service",outcome="accepted"} 1',
      );
      expect(body).toContain(
        'pi_cloud_tenant_admission_lock_wait_seconds_count{service="test-service"} 1',
      );
      expect(body).toContain(
        'pi_cloud_event_durability_seconds_count{service="test-service",outcome="success"} 1',
      );
      expect(body).toContain(
        'pi_cloud_event_durability_group_events_count{service="test-service"} 1',
      );
      expect(body).not.toContain("tenant_id");
    } finally {
      await endpoint.close();
    }
  });

  it("redacts sensitive structured-log fields", () => {
    let line = "";
    operationalLog({
      service: "test",
      level: "info",
      event: "run.completed",
      attributes: { runId: "run-1", prompt: "private", nested: { apiKey: "secret" } },
      write: (value) => {
        line = value;
      },
      now: () => new Date("2026-07-20T00:00:00.000Z"),
    });
    expect(line).toContain('"runId":"run-1"');
    expect(line).not.toContain("private");
    expect(line).not.toContain("secret");
    expect(line).toContain("[redacted]");
  });
});
