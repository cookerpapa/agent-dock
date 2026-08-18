#!/usr/bin/env node
const net = require("node:net");

const socket = net.createConnection(process.env.PI_CLOUD_SUBAGENT_BRIDGE_SOCKET);
let buffer = "";
socket.setEncoding("utf8");
socket.on("connect", () =>
  socket.write(
    `${JSON.stringify({
      args: process.argv.slice(2),
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.startsWith("PI_SUBAGENT_")),
      ),
    })}\n`,
  ),
);
socket.on("data", (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf("\n");
  if (newline < 0) return;
  const response = JSON.parse(buffer.slice(0, newline));
  const failed = response.state !== "completed";
  process.stdout.write(
    `${JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: response.output || response.failureMessage || "Subagent finished without output.",
          },
        ],
        api: "openai-completions",
        provider: "pi-cloud",
        model: "cloud-subagent",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: failed ? "error" : "stop",
        ...(failed ? { errorMessage: response.failureMessage || "Cloud Subagent failed" } : {}),
        timestamp: Date.now(),
      },
    })}\n`,
  );
  socket.end();
  process.exitCode = failed ? 1 : 0;
});
socket.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
