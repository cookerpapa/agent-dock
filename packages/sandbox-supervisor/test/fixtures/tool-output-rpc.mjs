import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const toolCallId = "tool-call-large-output";
const bytes = Buffer.alloc(2_048, 0x61);

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  void (async () => {
    const command = JSON.parse(line);
    if (command.type === "set_auto_retry") {
      output({ type: "response", id: command.id, command: command.type, success: true });
      return;
    }
    if (command.type !== "prompt") return;
    output({ type: "response", id: command.id, command: command.type, success: true });
    output({ type: "agent_start" });
    output({
      type: "tool_execution_start",
      toolCallId,
      toolName: "bash",
      args: { command: "large-output" },
    });
    const fileName = `${createHash("sha256").update(toolCallId, "utf8").digest("hex")}.output`;
    await writeFile(
      resolve(process.env.AGENT_DOCK_TRUSTED_TOOL_OUTPUT_DIRECTORY, fileName),
      bytes,
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    output({
      type: "tool_execution_end",
      toolCallId,
      toolName: "bash",
      isError: false,
      result: "bounded preview",
    });
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
    };
    output({ type: "message_end", message: assistant });
    output({ type: "agent_settled" });
  })();
});
