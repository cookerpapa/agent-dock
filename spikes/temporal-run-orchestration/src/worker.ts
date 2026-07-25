import { NativeConnection, Worker } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import * as activities from "./activities.ts";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Required environment variable ${name} is missing`);
  }
  return value;
}

const address = requiredEnvironment("AGENT_DOCK_TEMPORAL_ADDRESS");
const namespace = requiredEnvironment("AGENT_DOCK_TEMPORAL_NAMESPACE");
const taskQueue = requiredEnvironment("AGENT_DOCK_TEMPORAL_TASK_QUEUE");
const workerId = requiredEnvironment("AGENT_DOCK_TEMPORAL_WORKER_ID");

const connection = await NativeConnection.connect({ address });
const worker = await Worker.create({
  connection,
  namespace,
  taskQueue,
  workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
  activities,
  identity: workerId,
  maxConcurrentActivityTaskExecutions: 1,
  maxConcurrentWorkflowTaskExecutions: 8,
});

process.stdout.write(`${JSON.stringify({ type: "worker.ready", workerId, pid: process.pid })}\n`);

try {
  await worker.run();
} finally {
  await connection.close();
}
