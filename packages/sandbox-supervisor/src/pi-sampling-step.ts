import type { FrozenCloudStep } from "./cloud-context.ts";
import type { PiWorldStateModelMessage } from "./pi-sandbox-continuity.ts";

export type PiSamplingStepCapture = Readonly<{
  step: FrozenCloudStep;
  modelMessages: readonly PiWorldStateModelMessage[];
  samplingAttempt: number;
}>;

/**
 * Keeps provider transport retries inside one logical Cloud Step. Pi reports
 * retry scheduling between provider requests; the next context hook therefore
 * reuses the frozen Step instead of pretending that Tool/world state advanced.
 */
export class PiSamplingStepController {
  #active: Omit<PiSamplingStepCapture, "samplingAttempt"> | undefined;
  #scheduledSamplingAttempt: number | undefined;

  capture(
    createFresh: () => Omit<PiSamplingStepCapture, "samplingAttempt">,
  ): PiSamplingStepCapture {
    if (this.#scheduledSamplingAttempt !== undefined) {
      if (this.#active === undefined) {
        throw new Error("Pi scheduled a model retry before one Cloud Step was captured");
      }
      const samplingAttempt = this.#scheduledSamplingAttempt;
      this.#scheduledSamplingAttempt = undefined;
      return Object.freeze({ ...this.#active, samplingAttempt });
    }
    const fresh = createFresh();
    if (
      this.#active !== undefined &&
      fresh.step.context.sequence <= this.#active.step.context.sequence
    ) {
      throw new Error("Cloud Step sequence did not advance for a new model sampling boundary");
    }
    this.#active = Object.freeze({
      step: fresh.step,
      modelMessages: Object.freeze([...fresh.modelMessages]),
    });
    return Object.freeze({ ...this.#active, samplingAttempt: 1 });
  }

  scheduleRetry(retryAttempt: number): void {
    if (!Number.isSafeInteger(retryAttempt) || retryAttempt < 1) {
      throw new Error("Pi model retry attempt was invalid");
    }
    if (this.#active === undefined) {
      throw new Error("Pi scheduled a model retry without an active Cloud Step");
    }
    const samplingAttempt = retryAttempt + 1;
    if (this.#scheduledSamplingAttempt !== undefined) {
      throw new Error("Pi scheduled overlapping model retries");
    }
    this.#scheduledSamplingAttempt = samplingAttempt;
  }

  cancelScheduledRetry(): void {
    this.#scheduledSamplingAttempt = undefined;
  }
}
