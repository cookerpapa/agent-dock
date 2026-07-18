import type { InlineExtension, SessionEntry } from "@earendil-works/pi-coding-agent";

export const PORTABLE_COUNTER_ENTRY_TYPE = "agent-dock.portable-counter";

export type PortableCounterActivity = {
  phase: "rehydrated" | "command_started" | "command_finished" | "shutdown";
  piSessionId: string;
  value: number;
};

export type PortableCounterObserver = (activity: PortableCounterActivity) => void;

type CounterData = {
  value: number;
};

function isCounterData(value: unknown): value is CounterData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return Number.isSafeInteger(candidate.value) && Number(candidate.value) >= 0;
}

export function readPortableCounter(entries: readonly SessionEntry[]): number {
  let latest = 0;
  for (const entry of entries) {
    if (
      entry.type === "custom" &&
      entry.customType === PORTABLE_COUNTER_ENTRY_TYPE &&
      isCounterData(entry.data)
    ) {
      latest = entry.data.value;
    }
  }
  return latest;
}

function parseDelayMs(args: string): number {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  const delayMs = Number(trimmed);
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 5_000) {
    throw new Error("portable-counter delay must be an integer between 0 and 5000 ms");
  }
  return delayMs;
}

function delay(milliseconds: number): Promise<void> {
  if (milliseconds === 0) {
    return Promise.resolve();
  }
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

export function createPortableCounterExtension(
  observer?: PortableCounterObserver,
): InlineExtension {
  return {
    name: "agent-dock-portable-counter",
    factory(pi) {
      // Deliberately process-local. A new extension instance must reconstruct it
      // from Pi session entries instead of relying on this closure surviving.
      let value = 0;

      pi.on("session_start", (_event, context) => {
        value = readPortableCounter(context.sessionManager.getEntries());
        observer?.({
          phase: "rehydrated",
          piSessionId: context.sessionManager.getSessionId(),
          value,
        });
      });

      pi.on("session_shutdown", (_event, context) => {
        observer?.({
          phase: "shutdown",
          piSessionId: context.sessionManager.getSessionId(),
          value,
        });
      });

      pi.registerCommand("portable-counter", {
        description: "Increment state persisted through pi.appendEntry()",
        async handler(args, context) {
          const delayMs = parseDelayMs(args);
          const piSessionId = context.sessionManager.getSessionId();
          observer?.({ phase: "command_started", piSessionId, value });
          await delay(delayMs);
          value += 1;
          pi.appendEntry(PORTABLE_COUNTER_ENTRY_TYPE, { value });
          observer?.({ phase: "command_finished", piSessionId, value });
        },
      });
    },
  };
}
