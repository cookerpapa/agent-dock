import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  type ToolSandboxAssignment,
  type ToolSandboxCreateRequest,
  type ToolSandboxOperationRequest,
  type ToolSandboxOperationResponse,
} from "@agent-dock/protocol";
import {
  decodeWorkspaceSnapshotBlob,
  parseKopiaWorkspaceCheckpoint,
} from "@agent-dock/workspace-runtime";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { connect } from "node:net";
import { release as hostKernelRelease } from "node:os";
import { describe, expect, it } from "vitest";
import {
  CubeSandboxProvider,
  HttpWorkspaceDataMover,
  OfficialCubeSandboxRuntimeClient,
  ToolSandboxManager,
  type OfficialCubeSandboxRuntimeClientOptions,
} from "../src/index.ts";

const enabled = process.env.AGENT_DOCK_CUBESANDBOX_TEST === "1";

type LiveConfiguration = Readonly<{
  templateId: string;
  imageRevision: string;
  publicHttpsUrl: string;
  runtime: OfficialCubeSandboxRuntimeClientOptions;
  webProxy: Readonly<{ host: string; port: number }>;
  forbiddenEndpoints: readonly Readonly<{ host: string; port: number }>[];
}>;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length < 1) {
    throw new Error(`${name} is required by the CubeSandbox live gate`);
  }
  return value;
}

function port(value: string | undefined, fallback: number): number {
  const candidate = Number(value ?? String(fallback));
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > 65_535) {
    throw new Error("CubeSandbox live-gate port was invalid");
  }
  return candidate;
}

async function readPrivateKey(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
      throw new Error("CubeSandbox live-gate API key must be a private regular file");
    }
    const key = (await handle.readFile("utf8")).replace(/\r?\n$/, "");
    if (key.length < 32 || key.length > 4_096 || /[\u0000-\u001f\u007f]/.test(key)) {
      throw new Error("CubeSandbox live-gate API key was invalid");
    }
    return key;
  } finally {
    await handle.close();
  }
}

function parseForbiddenEndpoints(
  value: string,
): readonly Readonly<{ host: string; port: number }>[] {
  const endpoints = value.split(",").map((item) => item.trim());
  if (endpoints.length < 2) {
    throw new Error(
      "AGENT_DOCK_CUBESANDBOX_FORBIDDEN_ENDPOINTS must name at least two real platform endpoints",
    );
  }
  return endpoints.map((endpoint) => {
    const match = endpoint.match(/^([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?):(\d{1,5})$/);
    if (match === null) {
      throw new Error(`Forbidden endpoint ${endpoint} was invalid`);
    }
    return Object.freeze({ host: match[1]!, port: port(match[2], 1) });
  });
}

async function configuration(): Promise<LiveConfiguration> {
  const apiUrl = new URL(required("AGENT_DOCK_CUBESANDBOX_API_URL"));
  if (apiUrl.protocol !== "http:" && apiUrl.protocol !== "https:") {
    throw new Error("AGENT_DOCK_CUBESANDBOX_API_URL must use HTTP or HTTPS");
  }
  const publicHttpsUrl = new URL(
    process.env.AGENT_DOCK_CUBESANDBOX_PUBLIC_HTTPS_URL ?? "https://example.com/",
  );
  if (
    publicHttpsUrl.protocol !== "https:" ||
    publicHttpsUrl.username !== "" ||
    publicHttpsUrl.password !== "" ||
    publicHttpsUrl.hash !== ""
  ) {
    throw new Error("AGENT_DOCK_CUBESANDBOX_PUBLIC_HTTPS_URL must be a credential-free HTTPS URL");
  }
  const proxyScheme = process.env.AGENT_DOCK_CUBESANDBOX_PROXY_SCHEME ?? "http";
  if (proxyScheme !== "http" && proxyScheme !== "https") {
    throw new Error("AGENT_DOCK_CUBESANDBOX_PROXY_SCHEME was invalid");
  }
  const configured = parseForbiddenEndpoints(
    required("AGENT_DOCK_CUBESANDBOX_FORBIDDEN_ENDPOINTS"),
  );
  const apiEndpoint = Object.freeze({
    host: apiUrl.hostname,
    port: port(
      apiUrl.port === "" ? undefined : apiUrl.port,
      apiUrl.protocol === "https:" ? 443 : 80,
    ),
  });
  const egressProxyIp = process.env.AGENT_DOCK_CUBESANDBOX_EGRESS_PROXY_HOST ?? "10.255.255.254";
  const egressProxyPort = port(process.env.AGENT_DOCK_CUBESANDBOX_EGRESS_PROXY_PORT, 3_128);
  return {
    templateId: required("AGENT_DOCK_CUBESANDBOX_TEMPLATE_ID"),
    imageRevision: required("AGENT_DOCK_IMAGE_REVISION"),
    publicHttpsUrl: publicHttpsUrl.toString(),
    runtime: {
      apiUrl: apiUrl.toString(),
      apiKey: await readPrivateKey(required("AGENT_DOCK_CUBESANDBOX_API_KEY_FILE")),
      proxyNodeIp: required("AGENT_DOCK_CUBESANDBOX_PROXY_NODE_IP"),
      proxyPort: port(
        process.env.AGENT_DOCK_CUBESANDBOX_PROXY_PORT,
        proxyScheme === "https" ? 443 : 80,
      ),
      proxyScheme,
      sandboxDomain: process.env.AGENT_DOCK_CUBESANDBOX_DOMAIN ?? "cube.app",
      egressProxyIp,
      requestTimeoutMs: 30_000,
    },
    webProxy: { host: egressProxyIp, port: egressProxyPort },
    forbiddenEndpoints: [apiEndpoint, ...configured],
  };
}

function assignment(testRun: string, index: number): ToolSandboxAssignment {
  return {
    tenantId: `cube-live-${testRun}-tenant-${String(index)}`,
    projectId: `cube-live-${testRun}-project-${String(index)}`,
    workspaceId: `cube-live-${testRun}-workspace-${String(index)}`,
    supervisorId: `cube-live-${testRun}-supervisor`,
    bootId: randomUUID(),
    sandboxId: randomUUID(),
    commandId: `cube-live-${testRun}-command-${String(index)}`,
    sessionId: `cube-live-${testRun}-session-${String(index)}`,
    turnId: `cube-live-${testRun}-turn-${String(index)}`,
    attemptId: randomUUID(),
    leaseId: randomUUID(),
    fencingToken: index,
  };
}

function createRequest(
  assigned: ToolSandboxAssignment,
  imageRevision: string,
): ToolSandboxCreateRequest {
  return {
    managerProtocolVersion: 1,
    type: "tool_sandbox.create",
    requestId: randomUUID(),
    assignment: assigned,
    environment: {
      environmentVersionId: randomUUID(),
      versionNumber: 1,
      profileKey: "agent-dock-fullstack",
      profileVersion: "1",
      imageRevision,
      specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
      recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
      recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
    },
    workspaceSeed: { kind: "sample_java" },
  };
}

function operation(
  activationId: string,
  command: string,
  timeoutMs = 10_000,
): ToolSandboxOperationRequest {
  return {
    managerProtocolVersion: 1,
    type: "tool_sandbox.operation",
    activationId,
    operationId: randomUUID(),
    operation: "bash.exec",
    command,
    cwd: "/workspace",
    timeoutMs,
  };
}

function output(response: ToolSandboxOperationResponse): string {
  if (
    response.type !== "tool_sandbox.operation_result" ||
    response.operation !== "bash.exec" ||
    response.exitCode !== 0
  ) {
    const diagnostic =
      response.type === "tool_sandbox.operation_result" && response.operation === "bash.exec"
        ? {
            type: response.type,
            operation: response.operation,
            exitCode: response.exitCode,
            output: Buffer.from(response.output, "base64").toString("utf8").slice(0, 2_048),
          }
        : response.type === "tool_sandbox.operation_result"
          ? {
              type: response.type,
              operation: response.operation,
            }
          : {
              type: response.type,
              code: response.code,
              message: response.message,
              retryable: response.retryable,
            };
    throw new Error(`CubeSandbox live command did not succeed: ${JSON.stringify(diagnostic)}`);
  }
  return Buffer.from(response.output, "base64").toString("utf8");
}

async function assertReachableFromTrustedHost(
  endpoint: Readonly<{ host: string; port: number }>,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const socket = connect(endpoint.port, endpoint.host);
    const timer = setTimeout(() => {
      socket.destroy();
      rejectPromise(
        new Error(
          `Trusted host could not reach forbidden endpoint ${endpoint.host}:${String(endpoint.port)}`,
        ),
      );
    }, 3_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolvePromise();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
}

async function assertRawPublicHttpsFromTrustedHost(url: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const request = httpsGet(
      url,
      {
        headers: { "user-agent": "agent-dock-cube-egress-host-preflight/1" },
        timeout: 5_000,
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          const status = response.statusCode ?? 500;
          if (status < 200 || status >= 400) {
            rejectPromise(
              new Error(`trusted-host public HTTPS preflight returned HTTP ${String(status)}`),
            );
            return;
          }
          resolvePromise();
        });
      },
    );
    request.once("timeout", () => {
      request.destroy(new Error("trusted-host public HTTPS preflight timed out"));
    });
    request.once("error", (error) => {
      rejectPromise(
        new Error(
          "Cube full-egress acceptance requires a native public route on every Cube node; " +
            "an HTTP_PROXY-only host cannot provide CubeVS NAT egress",
          { cause: error },
        ),
      );
    });
  });
}

function denyProbeCommand(endpoints: readonly Readonly<{ host: string; port: number }>[]): string {
  const encoded = Buffer.from(JSON.stringify(endpoints), "utf8").toString("base64");
  const program =
    `const net=require('node:net');` +
    `const targets=JSON.parse(Buffer.from('${encoded}','base64'));` +
    `const probe=({host,port})=>new Promise(r=>{` +
    `const s=net.createConnection({host,port});` +
    `const done=v=>{s.destroy();r(v)};` +
    `s.setTimeout(2000,()=>done(false));` +
    `s.once('connect',()=>done(true));` +
    `s.once('error',()=>done(false));` +
    `});` +
    `Promise.all(targets.map(probe)).then(results=>{` +
    `const open=targets.filter((_,i)=>results[i]);` +
    `if(open.length){console.error(JSON.stringify(open));process.exit(91)}` +
    `process.stdout.write('all-forbidden-endpoints-blocked')` +
    `});`;
  return `node -e ${JSON.stringify(program)}`;
}

function publicHttpsProbeCommand(url: string): string {
  const encodedUrl = Buffer.from(url, "utf8").toString("base64");
  const program =
    `const https=require('node:https');` +
    `const url=Buffer.from('${encodedUrl}','base64').toString('utf8');` +
    `const fail=error=>{` +
    `process.stderr.write(String(error?.stack??error??'public HTTPS probe failed'));` +
    `process.exit(94)` +
    `};` +
    `const request=https.get(url,{` +
    `headers:{'user-agent':'agent-dock-cube-egress-check/1'},timeout:5000` +
    `},response=>{` +
    `response.resume();` +
    `response.once('end',()=>{` +
    `if((response.statusCode??500)<200||(response.statusCode??500)>=400)` +
    `fail('unexpected HTTP status '+response.statusCode);` +
    `process.stdout.write('public-egress-ok')` +
    `});` +
    `});` +
    `request.once('timeout',()=>{request.destroy();fail('public HTTPS probe timed out')});` +
    `request.once('error',fail);`;
  return `node -e ${JSON.stringify(program)}`;
}

async function waitForNoManagedInstances(
  config: LiveConfiguration,
  activationIds: ReadonlySet<string>,
): Promise<void> {
  const client = new OfficialCubeSandboxRuntimeClient(config.runtime);
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const remaining = (await client.list()).filter((instance) =>
        activationIds.has(instance.metadata["agentdock.activation_id"] ?? ""),
      );
      if (remaining.length === 0) return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    throw new Error("CubeSandbox live gate found orphaned AgentDock microVMs");
  } finally {
    await client.close();
  }
}

describe.skipIf(!enabled)("CubeSandbox KVM Provider live security gate", () => {
  it(
    "proves two-tenant isolation, full-public egress, private denial, cancellation and cleanup",
    async () => {
      const config = await configuration();
      await assertRawPublicHttpsFromTrustedHost(config.publicHttpsUrl);
      await Promise.all(
        config.forbiddenEndpoints.map((endpoint) => assertReachableFromTrustedHost(endpoint)),
      );

      const testRun = randomUUID().slice(0, 8);
      const firstAssignment = assignment(testRun, 1);
      const secondAssignment = assignment(testRun, 2);
      const provider = new CubeSandboxProvider({
        templateId: config.templateId,
        imageRevision: config.imageRevision,
        webProxy: config.webProxy,
        runtime: config.runtime,
        importGitHub: async () => {
          throw new Error("Repository import is outside the Cube live Provider gate");
        },
        workspaceDataMover: new HttpWorkspaceDataMover({
          baseUrl: required("AGENT_DOCK_WORKSPACE_DATA_MOVER_URL"),
          serviceToken: await readPrivateKey(
            required("AGENT_DOCK_WORKSPACE_DATA_MOVER_TOKEN_FILE"),
          ),
        }),
      });
      const manager = new ToolSandboxManager({
        provider,
        imageRevision: config.imageRevision,
      });
      const activationIds = new Set<string>();
      let first: Awaited<ReturnType<ToolSandboxManager["create"]>> | undefined;
      let second: Awaited<ReturnType<ToolSandboxManager["create"]>> | undefined;
      let activeFirstAssignment = firstAssignment;
      let activeSecondAssignment = secondAssignment;
      const startedAt = performance.now();
      let firstToolMs = 0;
      let secondToolMs = 0;
      try {
        await provider.checkHealth();
        const firstRequest = createRequest(firstAssignment, config.imageRevision);
        first = await manager.create(firstRequest);
        const secondRequest = createRequest(secondAssignment, config.imageRevision);
        second = await manager.create(secondRequest);
        activationIds.add(first.activationId);
        activationIds.add(second.activationId);

        const firstCanary = `tenant-a-${randomUUID()}`;
        const secondCanary = `tenant-b-${randomUUID()}`;
        const firstStartedAt = performance.now();
        expect(
          output(
            await manager.execute(
              first.capability,
              operation(first.activationId, `printf '%s' '${firstCanary}' > tenant-canary`),
            ),
          ),
        ).toBe("");
        firstToolMs = Math.round(performance.now() - firstStartedAt);

        const secondStartedAt = performance.now();
        expect(
          output(
            await manager.execute(
              second.capability,
              operation(second.activationId, `printf '%s' '${secondCanary}' > tenant-canary`),
            ),
          ),
        ).toBe("");
        secondToolMs = Math.round(performance.now() - secondStartedAt);

        expect(
          output(
            await manager.execute(
              first.capability,
              operation(first.activationId, "cat tenant-canary"),
            ),
          ),
        ).toBe(firstCanary);
        expect(
          output(
            await manager.execute(
              first.capability,
              operation(
                first.activationId,
                "node -e \"const fs=require('node:fs');fs.mkdirSync('large',{recursive:true});for(let i=0;i<600;i++)fs.writeFileSync('large/file-'+i,String(i))\"",
              ),
            ),
          ),
        ).toBe("");
        expect(
          output(
            await manager.execute(
              second.capability,
              operation(second.activationId, "cat tenant-canary"),
            ),
          ),
        ).toBe(secondCanary);

        const kernel = output(
          await manager.execute(first.capability, operation(first.activationId, "uname -r")),
        ).trim();
        expect(kernel).not.toBe(hostKernelRelease());
        await expect(manager.inspect(first.activationId, firstAssignment)).resolves.toMatchObject({
          state: "running",
          effectiveIsolation: {
            isolationBoundary: "microvm",
            runtime: "cubesandbox-kvm",
            user: "1000:1000",
            privileged: false,
            hasDockerSocket: false,
            networkMode: "public_web_proxy_private_denied",
            droppedCapabilities: ["ALL"],
            securityOptions: ["no-new-privileges"],
          },
        });

        expect(
          output(
            await manager.execute(
              first.capability,
              operation(
                first.activationId,
                "test ! -S /var/run/docker.sock; " +
                  "test ! -f /var/run/secrets/kubernetes.io/serviceaccount/token; " +
                  "if env | grep -Ei '(OPENAI|DEEPSEEK|DATABASE_URL|POSTGRES|MINIO|KUBECONFIG|CUBE_API_KEY)'; then exit 92; fi",
              ),
            ),
          ),
        ).toBe("");
        expect(
          output(
            await manager.execute(
              first.capability,
              operation(
                first.activationId,
                denyProbeCommand([
                  ...config.forbiddenEndpoints,
                  { host: "169.254.169.254", port: 80 },
                ]),
                15_000,
              ),
            ),
          ),
        ).toBe("all-forbidden-endpoints-blocked");
        expect(
          output(
            await manager.execute(
              first.capability,
              operation(first.activationId, publicHttpsProbeCommand(config.publicHttpsUrl), 15_000),
            ),
          ),
        ).toBe("public-egress-ok");

        const captured = await manager.capture(first.activationId, firstAssignment, randomUUID());
        expect(captured.type).toBe("tool_sandbox.captured");
        if (captured.type !== "tool_sandbox.captured") {
          throw new Error("CubeSandbox live Workspace capture was missing");
        }
        const checkpoint = parseKopiaWorkspaceCheckpoint(
          decodeWorkspaceSnapshotBlob(captured.workspace),
        );
        expect(checkpoint).toMatchObject({
          providerId: "cubesandbox",
          tenantId: firstAssignment.tenantId,
          workspaceId: firstAssignment.workspaceId,
          fencingToken: firstAssignment.fencingToken,
        });
        expect(checkpoint?.files.length).toBeGreaterThan(512);
        expect(checkpoint?.files.find((file) => file.path === "tenant-canary")).toMatchObject({
          sizeBytes: Buffer.byteLength(firstCanary),
        });
        await expect(
          manager.release({
            managerProtocolVersion: 1,
            type: "tool_sandbox.release",
            requestId: randomUUID(),
            activationId: first.activationId,
            assignment: firstAssignment,
            disposition: "destroy",
          }),
        ).resolves.toMatchObject({ retained: false });
        const restoredFirstAssignment: ToolSandboxAssignment = {
          ...firstAssignment,
          supervisorId: `cube-live-${testRun}-supervisor-restored`,
          bootId: randomUUID(),
          sandboxId: randomUUID(),
          commandId: `cube-live-${testRun}-command-restored`,
          turnId: `cube-live-${testRun}-turn-restored`,
          attemptId: randomUUID(),
          leaseId: randomUUID(),
          fencingToken: firstAssignment.fencingToken + 10,
        };
        activeFirstAssignment = restoredFirstAssignment;
        first = await manager.create({
          ...firstRequest,
          requestId: randomUUID(),
          assignment: restoredFirstAssignment,
          workspaceSeed: { kind: "sample_java" },
          workspaceRestore: captured.workspace,
        });
        activationIds.add(first.activationId);
        expect(
          output(
            await manager.execute(
              first.capability,
              operation(first.activationId, "cat tenant-canary"),
            ),
          ),
        ).toBe(firstCanary);

        const secondRuntimeBefore = (await manager.listAssignments(secondAssignment.sandboxId))[0];
        expect(secondRuntimeBefore).toBeDefined();
        const backgroundProgram = [
          "const fs=require('node:fs')",
          "const http=require('node:http')",
          "fs.writeFileSync('background-state','started\\n')",
          "setInterval(()=>fs.appendFileSync('background-state','tick\\n'),200)",
          "http.createServer((_request,response)=>response.end('preview-alive')).listen(43123,'0.0.0.0')",
        ].join(";");
        expect(
          output(
            await manager.execute(
              second.capability,
              operation(
                second.activationId,
                `nohup node -e ${JSON.stringify(backgroundProgram)} >/tmp/agentdock-preview.log 2>&1 & echo $! > background.pid; sleep 1; kill -0 "$(cat background.pid)"; node -e "fetch('http://127.0.0.1:43123').then(async r=>process.stdout.write(await r.text()))"`,
                15_000,
              ),
            ),
          ),
        ).toBe("preview-alive");
        const backgroundPid = output(
          await manager.execute(
            second.capability,
            operation(second.activationId, "cat background.pid"),
          ),
        ).trim();
        expect(backgroundPid).toMatch(/^[1-9][0-9]*$/);
        const secondCaptured = await manager.capture(
          second.activationId,
          secondAssignment,
          randomUUID(),
        );
        expect(secondCaptured.type).toBe("tool_sandbox.captured");
        const warmRevision = "c".repeat(64);
        await expect(
          manager.release({
            managerProtocolVersion: 1,
            type: "tool_sandbox.release",
            requestId: randomUUID(),
            activationId: second.activationId,
            assignment: secondAssignment,
            disposition: "keep_warm",
            workspaceRevision: warmRevision,
          }),
        ).resolves.toMatchObject({ retained: true });
        const reboundAssignment: ToolSandboxAssignment = {
          ...secondAssignment,
          supervisorId: `cube-live-${testRun}-supervisor-rebound`,
          bootId: randomUUID(),
          sandboxId: randomUUID(),
          commandId: `cube-live-${testRun}-command-rebound`,
          turnId: `cube-live-${testRun}-turn-rebound`,
          attemptId: randomUUID(),
          leaseId: randomUUID(),
          fencingToken: secondAssignment.fencingToken + 10,
        };
        activeSecondAssignment = reboundAssignment;
        second = await manager.create({
          ...secondRequest,
          requestId: randomUUID(),
          assignment: reboundAssignment,
          workspaceRevision: warmRevision,
        });
        expect(
          output(
            await manager.execute(
              second.capability,
              operation(
                second.activationId,
                `test "$(cat background.pid)" = "${backgroundPid}"; kill -0 "${backgroundPid}"; test "$(grep -c tick background-state)" -gt 0; node -e "fetch('http://127.0.0.1:43123').then(async r=>process.stdout.write(await r.text()))"`,
                15_000,
              ),
            ),
          ),
        ).toBe("preview-alive");
        expect(
          output(
            await manager.execute(
              second.capability,
              operation(second.activationId, "cat tenant-canary"),
            ),
          ),
        ).toBe(secondCanary);
        const secondRuntimeAfter = (await manager.listAssignments(reboundAssignment.sandboxId))[0];
        expect(secondRuntimeAfter?.containerId).toBe(secondRuntimeBefore?.containerId);
        expect(secondRuntimeAfter?.containerName).toBe(secondRuntimeBefore?.containerName);
        expect(secondRuntimeAfter?.fencingToken).toBe(reboundAssignment.fencingToken);

        const controller = new AbortController();
        const cancelled = manager.execute(
          first.capability,
          operation(first.activationId, "sleep 120", 125_000),
          controller.signal,
        );
        setTimeout(() => controller.abort(), 500).unref();
        await expect(cancelled).rejects.toMatchObject({ code: "tool_cancelled" });
        await expect(
          manager.inspect(first.activationId, activeFirstAssignment),
        ).resolves.toMatchObject({ state: "absent" });
      } finally {
        if (first !== undefined) {
          await manager.stop(first.activationId, activeFirstAssignment).catch(() => undefined);
        }
        if (second !== undefined) {
          await manager.stop(second.activationId, activeSecondAssignment).catch(() => undefined);
        }
        await manager.close().catch(() => undefined);
      }

      await waitForNoManagedInstances(config, activationIds);
      process.stdout.write(
        `${JSON.stringify({
          cubeSandboxLiveGate: {
            upstream: "TencentCloud/CubeSandbox@v0.6.0",
            isolationValidated: true,
            tenantCount: 2,
            firstToolMs,
            secondToolMs,
            totalMs: Math.round(performance.now() - startedAt),
            guestKernelDistinctFromHost: true,
            forbiddenEndpointCount: config.forbiddenEndpoints.length,
            publicInternetReachable: true,
            privateAndPlatformEgressDenied: true,
            backgroundProcessSurvivedRunBoundary: true,
            cancellationDestroyedMicroVm: true,
            orphanCount: 0,
          },
        })}\n`,
      );
    },
    10 * 60_000,
  );
});
