import { writeFileSync } from "node:fs";

const pidFile = process.argv[2];
if (pidFile === undefined) process.exit(2);

process.on("SIGTERM", () => {
  // Deliberately ignore graceful termination so the supervisor must target and
  // verify the whole process group, then escalate to SIGKILL.
});
writeFileSync(pidFile, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
setInterval(() => undefined, 1_000);
