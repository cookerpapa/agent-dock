import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("embedded Pi HTTP runtime", () => {
  it("installs one environment-aware undici dispatcher before SDK model calls", async () => {
    const moduleUrl = new URL("../src/http-runtime.ts", import.meta.url).href;
    const script = `
      import { getGlobalDispatcher } from "undici";
      import { ensureEmbeddedPiHttpRuntime } from ${JSON.stringify(moduleUrl)};

      const originalFetch = globalThis.fetch;
      const first = ensureEmbeddedPiHttpRuntime(1234);
      const second = ensureEmbeddedPiHttpRuntime(1234);
      let conflictingTimeoutRejected = false;
      try {
        ensureEmbeddedPiHttpRuntime(4321);
      } catch {
        conflictingTimeoutRejected = true;
      }
      process.stdout.write(JSON.stringify({
        first,
        second,
        conflictingTimeoutRejected,
        dispatcher: getGlobalDispatcher().constructor.name,
        fetchReplaced: globalThis.fetch !== originalFetch,
      }));
    `;
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        cwd,
        env: {
          ...process.env,
          HTTP_PROXY: "http://127.0.0.1:1",
          HTTPS_PROXY: "http://127.0.0.1:1",
          NO_PROXY: "localhost,127.0.0.1",
        },
      },
    );

    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      first: {
        installed: true,
        idleTimeoutMs: 1234,
        proxyEnvironmentPresent: true,
      },
      second: {
        installed: false,
        idleTimeoutMs: 1234,
        proxyEnvironmentPresent: true,
      },
      conflictingTimeoutRejected: true,
      dispatcher: "EnvHttpProxyAgent",
      fetchReplaced: true,
    });
  });
});
