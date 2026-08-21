import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("run-kafka-first-event-acceptance.ts", import.meta.url));
const reports = fileURLToPath(new URL("../docs/reports", import.meta.url));
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

const args = [
  "run",
  "--rm",
  "--network",
  "pi-cloud-production_event-log",
  "--volume",
  `${script}:/app/scripts/run-kafka-first-event-acceptance.ts:ro`,
  "--volume",
  `${reports}:/app/docs/reports`,
  "--env",
  "PI_CLOUD_KAFKA_BROKERS=kafka:9092",
  "--env",
  `PI_CLOUD_REVISION=${revision}`,
  "--workdir",
  "/app",
  "pi-cloud/control-plane:production",
  "/app/scripts/run-kafka-first-event-acceptance.ts",
  "--report",
];

await new Promise((resolve, reject) => {
  const child = execFile("docker", args, { cwd: root });
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) resolve();
    else
      reject(
        new Error(
          `Kafka acceptance container failed (code=${String(code)}, signal=${String(signal)})`,
        ),
      );
  });
});
