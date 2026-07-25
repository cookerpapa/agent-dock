import { CancelledFailure, activityInfo, heartbeat, sleep } from "@temporalio/activity";
import { appendFile } from "node:fs/promises";
import {
  validateWorkflowInput,
  type TemporalRunActivityResult,
  type TemporalRunWorkflowInput,
  type TemporalSpikeLedgerEntry,
} from "./contract.ts";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Required environment variable ${name} is missing`);
  }
  return value;
}

async function record(
  input: TemporalRunWorkflowInput,
  phase: TemporalSpikeLedgerEntry["phase"],
): Promise<void> {
  const info = activityInfo();
  const entry: TemporalSpikeLedgerEntry = {
    phase,
    runId: input.runId,
    workerId: requiredEnvironment("AGENT_DOCK_TEMPORAL_WORKER_ID"),
    workerPid: process.pid,
    activityAttempt: info.attempt,
    fencingToken: input.attemptBaseFence + info.attempt - 1,
    timestamp: new Date().toISOString(),
  };
  await appendFile(
    requiredEnvironment("AGENT_DOCK_TEMPORAL_LEDGER_PATH"),
    `${JSON.stringify(entry)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

export async function executeRunAttempt(
  rawInput: TemporalRunWorkflowInput,
): Promise<TemporalRunActivityResult> {
  const input = validateWorkflowInput(rawInput);
  const info = activityInfo();
  const fencingToken = input.attemptBaseFence + info.attempt - 1;
  await record(input, "started");

  try {
    const deadline =
      Date.now() +
      (input.mode === "crash_recovery" && info.attempt === 1 ? 60_000 : input.simulatedDurationMs);
    let nextProgressRecord = Date.now() + 500;
    while (Date.now() < deadline) {
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
      heartbeat({ runId: input.runId, fencingToken });
      if (Date.now() >= nextProgressRecord) {
        await record(input, "heartbeat");
        nextProgressRecord = Date.now() + 500;
      }
    }
  } catch (error: unknown) {
    if (error instanceof CancelledFailure) {
      await record(input, "cancelled");
    }
    throw error;
  }

  await record(input, "completed");
  return {
    runId: input.runId,
    workerId: requiredEnvironment("AGENT_DOCK_TEMPORAL_WORKER_ID"),
    activityAttempt: info.attempt,
    fencingToken,
    promptRef: input.promptRef,
    checkpointRef: `s3://agent-dock-spike/checkpoints/${input.runId}/${String(fencingToken)}`,
  };
}
