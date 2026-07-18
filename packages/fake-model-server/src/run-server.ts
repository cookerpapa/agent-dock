import { FakeModelServer } from "./index.ts";

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return 4010;
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("FAKE_MODEL_PORT must be an integer between 1 and 65535");
  }
  return port;
}

const server = new FakeModelServer({
  host: process.env.FAKE_MODEL_HOST ?? "127.0.0.1",
  port: parsePort(process.env.FAKE_MODEL_PORT),
});

await server.start();
process.stdout.write(
  `${JSON.stringify(
    {
      status: "listening",
      baseUrl: server.baseUrl,
      credential: "fixed local test key; see package README",
    },
    null,
    2,
  )}\n`,
);

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  await server.stop();
  process.stdout.write(`${JSON.stringify({ status: "stopped", signal })}\n`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void stop(signal).then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  });
}
