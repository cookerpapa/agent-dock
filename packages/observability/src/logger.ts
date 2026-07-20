import { context, trace } from "@opentelemetry/api";

export type OperationalLogLevel = "debug" | "info" | "warn" | "error";

const SENSITIVE_KEY =
  /(authorization|api[_-]?key|token|secret|password|credential|prompt|content)/i;

function safeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth-limited]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length <= 512 ? value : `${value.slice(0, 512)}…`;
  if (Array.isArray(value)) return value.slice(0, 32).map((entry) => safeValue(entry, depth + 1));
  if (typeof value !== "object") return String(value);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 64)
      .map(([key, entry]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[redacted]" : safeValue(entry, depth + 1),
      ]),
  );
}

export function operationalLog(options: {
  service: string;
  level: OperationalLogLevel;
  event: string;
  attributes?: Record<string, unknown>;
  write?: (line: string) => void;
  now?: () => Date;
}): void {
  if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(options.event)) {
    throw new TypeError("Operational log event is invalid");
  }
  const span = trace.getSpan(context.active())?.spanContext();
  const record = {
    timestamp: (options.now ?? (() => new Date()))().toISOString(),
    level: options.level,
    service: options.service,
    event: options.event,
    ...(span === undefined ? {} : { traceId: span.traceId, spanId: span.spanId }),
    ...(options.attributes === undefined ? {} : { attributes: safeValue(options.attributes) }),
  };
  (options.write ?? ((line) => process.stdout.write(line)))(`${JSON.stringify(record)}\n`);
}
