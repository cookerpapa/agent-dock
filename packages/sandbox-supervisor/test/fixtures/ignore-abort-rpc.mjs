import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

const pidFile = `${process.cwd()}/descendant.pid`;
let descendant;

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function waitForDescendant() {
  return new Promise((resolve) => {
    const check = () => {
      if (existsSync(pidFile)) {
        resolve();
      } else {
        setTimeout(check, 5);
      }
    };
    check();
  });
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  void (async () => {
    const command = JSON.parse(line);
    if (command.type === "set_auto_retry") {
      output({ type: "response", id: command.id, command: command.type, success: true });
      return;
    }
    if (command.type === "prompt") {
      descendant ??= spawn(
        process.execPath,
        [new URL("./ignore-term-descendant.mjs", import.meta.url).pathname, pidFile],
        { stdio: "ignore" },
      );
      await waitForDescendant();
      output({ type: "response", id: command.id, command: command.type, success: true });
      output({ type: "agent_start" });
      return;
    }
    if (command.type === "abort") {
      output({ type: "response", id: command.id, command: command.type, success: true });
      // Deliberately never emit agent_settled.
    }
  })();
});

setInterval(() => undefined, 1_000);
