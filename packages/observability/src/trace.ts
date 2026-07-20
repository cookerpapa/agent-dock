import {
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";

export type TraceCarrier = Readonly<{
  traceparent: string;
  tracestate?: string;
}>;

export type TelemetryRuntime = Readonly<{
  enabled: boolean;
  shutdown(): Promise<void>;
}>;

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(0[01])$/;

class DiscardSpanProcessor implements SpanProcessor {
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  onStart(): void {}

  onEnd(_span: ReadableSpan): void {}

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

function nonZeroHex(value: string): boolean {
  return /[1-9a-f]/.test(value);
}

export function parseTraceCarrier(value: unknown): TraceCarrier | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const traceparent = (value as { traceparent?: unknown }).traceparent;
  const tracestate = (value as { tracestate?: unknown }).tracestate;
  if (typeof traceparent !== "string") return undefined;
  const match = TRACEPARENT.exec(traceparent);
  if (match === null || !nonZeroHex(match[1]!) || !nonZeroHex(match[2]!)) return undefined;
  if (
    tracestate !== undefined &&
    (typeof tracestate !== "string" || tracestate.length < 1 || tracestate.length > 512)
  ) {
    return undefined;
  }
  return tracestate === undefined ? { traceparent } : { traceparent, tracestate };
}

export function virtualRunTraceCarrier(traceId: string, parentSpanId: string): TraceCarrier {
  const carrier = parseTraceCarrier({ traceparent: `00-${traceId}-${parentSpanId}-01` });
  if (carrier === undefined) throw new TypeError("Run trace identity is invalid");
  return carrier;
}

export function extractedTraceContext(carrier: TraceCarrier | undefined): Context {
  if (carrier === undefined) return context.active();
  return propagation.extract(context.active(), carrier as Record<string, string>);
}

export function activeTraceCarrier(): TraceCarrier | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return parseTraceCarrier(carrier);
}

export async function withSpan<T>(options: {
  serviceName: string;
  name: string;
  parent?: TraceCarrier;
  attributes?: Attributes;
  run: (span: Span) => Promise<T> | T;
}): Promise<T> {
  const tracer = trace.getTracer(options.serviceName);
  return (await tracer.startActiveSpan(
    options.name,
    options.attributes === undefined ? {} : { attributes: options.attributes },
    extractedTraceContext(options.parent),
    async (span) => {
      try {
        const result = await options.run(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error: unknown) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: safeErrorCode(error) });
        span.recordException(error instanceof Error ? error : new Error("unknown_error"));
        throw error;
      } finally {
        span.end();
      }
    },
  )) as T;
}

export function safeErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_.-]{0,127}$/.test(error.code)
  ) {
    return error.code;
  }
  return error instanceof TypeError ? "type_error" : "operation_failed";
}

export async function initializeTelemetry(options: {
  serviceName: string;
  endpoint?: string;
}): Promise<TelemetryRuntime> {
  const endpoint =
    options.endpoint === undefined || options.endpoint.length === 0
      ? undefined
      : new URL(options.endpoint);
  if (endpoint !== undefined && endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new TypeError("OTLP trace endpoint must use HTTP or HTTPS");
  }
  const sdk = new NodeSDK({
    serviceName: options.serviceName,
    ...(endpoint === undefined
      ? { spanProcessors: [new DiscardSpanProcessor()] }
      : { traceExporter: new OTLPTraceExporter({ url: endpoint.toString() }) }),
  });
  await sdk.start();
  return { enabled: endpoint !== undefined, shutdown: () => sdk.shutdown() };
}
