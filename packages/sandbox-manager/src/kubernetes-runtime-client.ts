import {
  Attach,
  CoreV1Api,
  Exec,
  KubeConfig,
  NetworkingV1Api,
  NodeV1Api,
  type V1ConfigMap,
  type V1Endpoints,
  type V1NetworkPolicy,
  type V1Pod,
  type V1RuntimeClass,
  type V1Service,
  type V1Status,
} from "@kubernetes/client-node";
import { PassThrough, type Readable, type Writable } from "node:stream";
import type WebSocket from "isomorphic-ws";
import { SandboxManagerError } from "./sandbox-provider.ts";

export type KubernetesImagePullPolicy = "Always" | "IfNotPresent" | "Never";

export interface KubernetesRuntimeClient {
  createPod(namespace: string, pod: V1Pod): Promise<V1Pod>;
  readPod(namespace: string, name: string): Promise<V1Pod | undefined>;
  listPods(namespace: string, labelSelector: string): Promise<readonly V1Pod[]>;
  patchPodMetadata(
    namespace: string,
    name: string,
    uid: string,
    resourceVersion: string,
    labels: Readonly<Record<string, string>>,
    annotations: Readonly<Record<string, string>>,
  ): Promise<V1Pod>;
  deletePod(
    namespace: string,
    name: string,
    uid: string,
    gracePeriodSeconds: number,
  ): Promise<void>;
  readPodLog(namespace: string, name: string, containerName: string): Promise<string>;
  readConfigMap(namespace: string, name: string): Promise<V1ConfigMap | undefined>;
  patchConfigMapData(
    namespace: string,
    name: string,
    resourceVersion: string,
    data: Readonly<Record<string, string>>,
  ): Promise<V1ConfigMap>;
  readService(namespace: string, name: string): Promise<V1Service | undefined>;
  readEndpoints(namespace: string, name: string): Promise<V1Endpoints | undefined>;
  readNetworkPolicy(namespace: string, name: string): Promise<V1NetworkPolicy | undefined>;
  readRuntimeClass(name: string): Promise<V1RuntimeClass | undefined>;
  attach(
    namespace: string,
    podName: string,
    containerName: string,
    stdout: Writable,
    stderr: Writable,
    stdin: Readable,
  ): Promise<WebSocket>;
  exec(
    namespace: string,
    podName: string,
    containerName: string,
    command: readonly string[],
    timeoutMs: number,
    maximumOutputBytes: number,
  ): Promise<{ stdout: Buffer; stderr: Buffer; status: V1Status }>;
}

function apiStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error && typeof error.code === "number") return error.code;
  if ("statusCode" in error && typeof error.statusCode === "number") return error.statusCode;
  if (
    "body" in error &&
    typeof error.body === "object" &&
    error.body !== null &&
    "code" in error.body &&
    typeof error.body.code === "number"
  ) {
    return error.body.code;
  }
  if (
    "response" in error &&
    typeof error.response === "object" &&
    error.response !== null &&
    "statusCode" in error.response &&
    typeof error.response.statusCode === "number"
  ) {
    return error.response.statusCode;
  }
  return undefined;
}

function kubernetesFailure(error: unknown, operation: string): SandboxManagerError {
  const status = apiStatus(error);
  return new SandboxManagerError(
    status === 403 ? "kubernetes_authorization_failed" : "kubernetes_api_unavailable",
    status === 403
      ? `Kubernetes denied the Sandbox Manager ${operation}`
      : `Kubernetes could not complete the Sandbox Manager ${operation}`,
    status !== 403,
  );
}

export class OfficialKubernetesRuntimeClient implements KubernetesRuntimeClient {
  readonly #core: CoreV1Api;
  readonly #networking: NetworkingV1Api;
  readonly #node: NodeV1Api;
  readonly #attach: Attach;
  readonly #exec: Exec;

  constructor(kubeconfigPath: string) {
    const config = new KubeConfig();
    try {
      config.loadFromFile(kubeconfigPath);
    } catch {
      throw new TypeError("Sandbox Manager kubeconfig could not be loaded");
    }
    const cluster = config.getCurrentCluster();
    const user = config.getCurrentUser();
    if (
      cluster === null ||
      !cluster.server.startsWith("https://") ||
      cluster.skipTLSVerify === true ||
      typeof cluster.caData !== "string" ||
      cluster.caData.length < 128 ||
      cluster.caData.length > 16_384 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(cluster.caData) ||
      cluster.caFile !== undefined ||
      cluster.proxyUrl !== undefined ||
      user === null ||
      typeof user.token !== "string" ||
      user.token.length < 32 ||
      user.token.length > 16_384 ||
      user.exec !== undefined ||
      user.authProvider !== undefined ||
      user.certData !== undefined ||
      user.certFile !== undefined ||
      user.keyData !== undefined ||
      user.keyFile !== undefined ||
      user.username !== undefined ||
      user.password !== undefined ||
      user.impersonateUser !== undefined
    ) {
      throw new TypeError("Sandbox Manager kubeconfig is not a fixed TLS bearer configuration");
    }
    this.#core = config.makeApiClient(CoreV1Api);
    this.#networking = config.makeApiClient(NetworkingV1Api);
    this.#node = config.makeApiClient(NodeV1Api);
    this.#attach = new Attach(config);
    this.#exec = new Exec(config);
  }

  async createPod(namespace: string, pod: V1Pod): Promise<V1Pod> {
    try {
      return await this.#core.createNamespacedPod({
        namespace,
        body: pod,
        fieldManager: "agent-dock-sandbox-manager",
        fieldValidation: "Strict",
      });
    } catch (error: unknown) {
      throw kubernetesFailure(error, "Pod creation");
    }
  }

  async readPod(namespace: string, name: string): Promise<V1Pod | undefined> {
    try {
      return await this.#core.readNamespacedPod({ namespace, name });
    } catch (error: unknown) {
      if (apiStatus(error) === 404) return undefined;
      throw kubernetesFailure(error, "Pod inspection");
    }
  }

  async listPods(namespace: string, labelSelector: string): Promise<readonly V1Pod[]> {
    try {
      const items: V1Pod[] = [];
      let continuation: string | undefined;
      do {
        const result = await this.#core.listNamespacedPod({
          namespace,
          labelSelector,
          limit: 250,
          ...(continuation === undefined ? {} : { _continue: continuation }),
        });
        items.push(...result.items);
        if (items.length > 1_000) {
          throw new SandboxManagerError(
            "kubernetes_inventory_ambiguous",
            "Kubernetes managed Pod inventory exceeded its safe scope",
            false,
          );
        }
        continuation = result.metadata?._continue || undefined;
      } while (continuation !== undefined);
      return items;
    } catch (error: unknown) {
      if (error instanceof SandboxManagerError) throw error;
      throw kubernetesFailure(error, "Pod inventory");
    }
  }

  async patchPodMetadata(
    namespace: string,
    name: string,
    uid: string,
    resourceVersion: string,
    labels: Readonly<Record<string, string>>,
    annotations: Readonly<Record<string, string>>,
  ): Promise<V1Pod> {
    try {
      return await this.#core.patchNamespacedPod({
        namespace,
        name,
        fieldManager: "agent-dock-sandbox-manager",
        body: [
          { op: "test", path: "/metadata/uid", value: uid },
          { op: "test", path: "/metadata/resourceVersion", value: resourceVersion },
          { op: "replace", path: "/metadata/labels", value: labels },
          { op: "replace", path: "/metadata/annotations", value: annotations },
        ],
      });
    } catch (error: unknown) {
      if (apiStatus(error) === 409 || apiStatus(error) === 422) {
        throw new SandboxManagerError(
          "kubernetes_pod_identity_mismatch",
          "Kubernetes rejected a stale Pod metadata precondition",
          false,
        );
      }
      throw kubernetesFailure(error, "Pod metadata update");
    }
  }

  async deletePod(
    namespace: string,
    name: string,
    uid: string,
    gracePeriodSeconds: number,
  ): Promise<void> {
    try {
      await this.#core.deleteNamespacedPod({
        namespace,
        name,
        gracePeriodSeconds,
        propagationPolicy: "Background",
        body: {
          apiVersion: "v1",
          kind: "DeleteOptions",
          gracePeriodSeconds,
          propagationPolicy: "Background",
          preconditions: { uid },
        },
      });
    } catch (error: unknown) {
      if (apiStatus(error) === 404) return;
      if (apiStatus(error) === 409) {
        throw new SandboxManagerError(
          "kubernetes_pod_identity_mismatch",
          "Kubernetes rejected a stale Pod deletion precondition",
          false,
        );
      }
      throw kubernetesFailure(error, "Pod deletion");
    }
  }

  async readPodLog(namespace: string, name: string, containerName: string): Promise<string> {
    try {
      return await this.#core.readNamespacedPodLog({
        namespace,
        name,
        container: containerName,
        limitBytes: 64 * 1_024,
      });
    } catch (error: unknown) {
      throw kubernetesFailure(error, "Pod log read");
    }
  }

  async readConfigMap(namespace: string, name: string): Promise<V1ConfigMap | undefined> {
    try {
      return await this.#core.readNamespacedConfigMap({ namespace, name });
    } catch (error: unknown) {
      if (apiStatus(error) === 404) return undefined;
      throw kubernetesFailure(error, "ConfigMap inspection");
    }
  }

  async patchConfigMapData(
    namespace: string,
    name: string,
    resourceVersion: string,
    data: Readonly<Record<string, string>>,
  ): Promise<V1ConfigMap> {
    try {
      return await this.#core.patchNamespacedConfigMap({
        namespace,
        name,
        fieldManager: "agent-dock-sandbox-manager",
        body: [
          { op: "test", path: "/metadata/resourceVersion", value: resourceVersion },
          { op: "add", path: "/data", value: data },
        ],
      });
    } catch (error: unknown) {
      if (apiStatus(error) === 409 || apiStatus(error) === 422) {
        throw new SandboxManagerError(
          "kubernetes_config_identity_mismatch",
          "Kubernetes rejected a stale dependency egress trust update",
          true,
        );
      }
      throw kubernetesFailure(error, "ConfigMap update");
    }
  }

  async readService(namespace: string, name: string): Promise<V1Service | undefined> {
    try {
      return await this.#core.readNamespacedService({ namespace, name });
    } catch (error: unknown) {
      if (apiStatus(error) === 404) return undefined;
      throw kubernetesFailure(error, "Service inspection");
    }
  }

  async readEndpoints(namespace: string, name: string): Promise<V1Endpoints | undefined> {
    try {
      return await this.#core.readNamespacedEndpoints({ namespace, name });
    } catch (error: unknown) {
      if (apiStatus(error) === 404) return undefined;
      throw kubernetesFailure(error, "Endpoint inspection");
    }
  }

  async readNetworkPolicy(namespace: string, name: string): Promise<V1NetworkPolicy | undefined> {
    try {
      return await this.#networking.readNamespacedNetworkPolicy({ namespace, name });
    } catch (error: unknown) {
      if (apiStatus(error) === 404) return undefined;
      throw kubernetesFailure(error, "NetworkPolicy inspection");
    }
  }

  async readRuntimeClass(name: string): Promise<V1RuntimeClass | undefined> {
    try {
      return await this.#node.readRuntimeClass({ name });
    } catch (error: unknown) {
      if (apiStatus(error) === 404) return undefined;
      throw kubernetesFailure(error, "RuntimeClass inspection");
    }
  }

  async attach(
    namespace: string,
    podName: string,
    containerName: string,
    stdout: Writable,
    stderr: Writable,
    stdin: Readable,
  ): Promise<WebSocket> {
    try {
      return await this.#attach.attach(
        namespace,
        podName,
        containerName,
        stdout,
        stderr,
        stdin,
        false,
      );
    } catch (error: unknown) {
      throw kubernetesFailure(error, "Pod attachment");
    }
  }

  async exec(
    namespace: string,
    podName: string,
    containerName: string,
    command: readonly string[],
    timeoutMs: number,
    maximumOutputBytes: number,
  ): Promise<{ stdout: Buffer; stderr: Buffer; status: V1Status }> {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let stdoutBytes = Buffer.alloc(0);
    let stderrBytes = Buffer.alloc(0);
    let overflow = false;
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      if (overflow) return;
      if (target === "stdout") stdoutBytes = Buffer.concat([stdoutBytes, chunk]);
      else stderrBytes = Buffer.concat([stderrBytes, chunk]);
      if (stdoutBytes.byteLength + stderrBytes.byteLength > maximumOutputBytes) overflow = true;
    };
    stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    stderr.on("data", (chunk: Buffer) => append("stderr", chunk));

    let connection: WebSocket | undefined;
    let settled = false;
    const status = new Promise<V1Status>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        connection?.close();
        rejectPromise(
          new SandboxManagerError("kubernetes_exec_timeout", "Kubernetes Pod exec timed out", true),
        );
      }, timeoutMs);
      timer.unref();
      void this.#exec
        .exec(
          namespace,
          podName,
          containerName,
          [...command],
          stdout,
          stderr,
          null,
          false,
          (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolvePromise(value);
          },
        )
        .then((value) => {
          connection = value;
          value.once("error", () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            rejectPromise(
              new SandboxManagerError(
                "kubernetes_exec_failed",
                "Kubernetes Pod exec connection failed",
                true,
              ),
            );
          });
          value.once("close", () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            rejectPromise(
              new SandboxManagerError(
                "kubernetes_exec_failed",
                "Kubernetes Pod exec closed without a status",
                true,
              ),
            );
          });
        })
        .catch((error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          rejectPromise(kubernetesFailure(error, "Pod exec"));
        });
    });
    const result = await status;
    connection?.close();
    if (overflow) {
      throw new SandboxManagerError(
        "kubernetes_exec_output_limit",
        "Kubernetes Pod exec output exceeded its limit",
        false,
      );
    }
    return { stdout: stdoutBytes, stderr: stderrBytes, status: result };
  }
}
