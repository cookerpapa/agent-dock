import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type ComposeService = {
  image?: string;
  build?: { context?: string; dockerfile?: string };
  user?: string;
  read_only?: boolean;
  tmpfs?: string[];
  network_mode?: string;
  init?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  pids_limit?: number;
  mem_limit?: string;
  cpus?: number;
  ulimits?: unknown;
  stop_grace_period?: string;
  restart?: string;
  environment?: Record<string, string>;
  volumes?: unknown;
  ports?: unknown;
  privileged?: boolean;
  pid?: string;
  ipc?: string;
  devices?: unknown;
  secrets?: unknown;
};

type ComposeDocument = {
  name?: string;
  services?: Record<string, ComposeService>;
};

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const pinnedNodeImage =
  "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d";

const expectedServices = {
  "pi-extension-compat": {
    image: "agent-dock/pi-extension-compat:phase0",
    dockerfile: "spikes/pi-extension-compat/Dockerfile",
  },
  "pi-embedded-rehydrate": {
    image: "agent-dock/pi-embedded-rehydrate:phase0",
    dockerfile: "spikes/pi-embedded-rehydrate/Dockerfile",
  },
} as const;

describe("Phase 0 container topology", () => {
  it("applies the sandbox restrictions to every one-shot runner", async () => {
    const compose = parse(
      await readFile(resolve(repositoryRoot, "compose.yaml"), "utf8"),
    ) as ComposeDocument;
    expect(compose.name).toBe("agent-dock-phase0");
    expect(Object.keys(compose.services ?? {}).sort()).toEqual(
      Object.keys(expectedServices).sort(),
    );

    for (const [name, expected] of Object.entries(expectedServices)) {
      const service = compose.services?.[name];
      expect(service, `${name} must exist`).toBeDefined();
      expect(service).toMatchObject({
        image: expected.image,
        build: { context: ".", dockerfile: expected.dockerfile },
        user: "1000:1000",
        read_only: true,
        tmpfs: ["/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777"],
        network_mode: "none",
        init: true,
        cap_drop: ["ALL"],
        security_opt: ["no-new-privileges:true"],
        pids_limit: 128,
        mem_limit: "512m",
        cpus: 1,
        ulimits: { nofile: { soft: 1024, hard: 1024 } },
        stop_grace_period: "10s",
        restart: "no",
        environment: {
          AGENT_DOCK_REQUIRE_NON_ROOT: "1",
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
        },
      });
      expect(service?.volumes).toBeUndefined();
      expect(service?.ports).toBeUndefined();
      expect(service?.privileged).not.toBe(true);
      expect(service?.pid).not.toBe("host");
      expect(service?.ipc).not.toBe("host");
      expect(service?.devices).toBeUndefined();
      expect(service?.secrets).toBeUndefined();
    }
  });

  it("pins minimal non-root images and allowlists the Docker build context", async () => {
    for (const { dockerfile } of Object.values(expectedServices)) {
      const contents = await readFile(resolve(repositoryRoot, dockerfile), "utf8");
      const firstInstruction = contents.split("\n").find((line) => line.trim().length > 0);
      expect(firstInstruction).toBe(`FROM ${pinnedNodeImage}`);
      expect(contents).toContain("npm ci --omit=dev --ignore-scripts");
      expect(contents).toContain("node scripts/harden-pi-dependencies.mjs");
      expect(contents).toContain("node scripts/harden-pi-dependencies.mjs --check");
      expect(contents).toMatch(/^ENV NODE_ENV=production/m);
      expect(contents).toContain("AGENT_DOCK_REQUIRE_NON_ROOT=1");
      expect(contents).toMatch(/^USER 1000:1000$/m);
      expect(contents.indexOf("USER 1000:1000")).toBeLessThan(contents.indexOf("CMD ["));
      expect(contents).not.toMatch(/^COPY\s+\.\s/m);
      expect(contents).not.toMatch(/(?:auth\.json|\.npmrc|\.env|Docker\.sock)/i);
    }

    const dockerIgnore = await readFile(resolve(repositoryRoot, ".dockerignore"), "utf8");
    const rules = dockerIgnore
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(rules[0]).toBe("**");
    expect(rules).toEqual(
      expect.arrayContaining([
        "!package.json",
        "!package-lock.json",
        "!scripts/harden-pi-dependencies.mjs",
        "!packages/protocol/src/**",
        "!packages/sandbox-supervisor/src/**",
        "!spikes/pi-extension-compat/src/**",
        "!spikes/pi-embedded-rehydrate/src/**",
      ]),
    );
    expect(
      rules.some((rule) => /^!(?:\.env|\.npmrc|auth\.json|sessions|workspaces)/i.test(rule)),
    ).toBe(false);
  });
});
