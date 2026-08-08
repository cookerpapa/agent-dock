export const MODEL_STEP_SEQUENCE_HEADER = "x-agent-dock-step-sequence" as const;
export const MODEL_STEP_SHA256_HEADER = "x-agent-dock-step-sha256" as const;
export const MODEL_SAMPLING_ATTEMPT_HEADER = "x-agent-dock-sampling-attempt" as const;

export type ModelSamplingIdentity = Readonly<{
  stepSequence: number;
  stepSha256: string;
  samplingAttempt: number;
}>;

function positiveSafeInteger(value: unknown, name: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^(?:[1-9][0-9]*)$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return parsed;
}

export function parseModelSamplingIdentity(value: {
  stepSequence: unknown;
  stepSha256: unknown;
  samplingAttempt: unknown;
}): ModelSamplingIdentity {
  if (typeof value.stepSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.stepSha256)) {
    throw new TypeError("Model sampling Step digest is invalid");
  }
  return Object.freeze({
    stepSequence: positiveSafeInteger(value.stepSequence, "Model sampling Step sequence"),
    stepSha256: value.stepSha256,
    samplingAttempt: positiveSafeInteger(value.samplingAttempt, "Model sampling attempt"),
  });
}

export function modelSamplingHeaders(identity: ModelSamplingIdentity): Record<string, string> {
  const parsed = parseModelSamplingIdentity(identity);
  return {
    [MODEL_STEP_SEQUENCE_HEADER]: String(parsed.stepSequence),
    [MODEL_STEP_SHA256_HEADER]: parsed.stepSha256,
    [MODEL_SAMPLING_ATTEMPT_HEADER]: String(parsed.samplingAttempt),
  };
}
