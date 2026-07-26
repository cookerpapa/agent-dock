import { setTimeout as delay } from "node:timers/promises";

export type CubeEgressRuntimeConfiguration = Readonly<{
  enabled: boolean;
  upstreamProxyUrl?: URL;
  revision: number;
}>;

export class CubeEgressConfigurationPoller {
  readonly #controlPlaneUrl: string;
  readonly #serviceToken: string;
  readonly #pollIntervalMs: number;
  readonly #abort = new AbortController();
  #current: CubeEgressRuntimeConfiguration | undefined;
  #loop: Promise<void> | undefined;

  constructor(options: { controlPlaneUrl: string; serviceToken: string; pollIntervalMs: number }) {
    this.#controlPlaneUrl = options.controlPlaneUrl;
    this.#serviceToken = options.serviceToken;
    this.#pollIntervalMs = options.pollIntervalMs;
  }

  get current(): CubeEgressRuntimeConfiguration | undefined {
    return this.#current;
  }

  async start(): Promise<void> {
    if (this.#loop !== undefined) throw new Error("Cube egress configuration poller started twice");
    await this.#refresh();
    this.#loop = this.#run();
  }

  async close(): Promise<void> {
    this.#abort.abort();
    await this.#loop;
  }

  async #run(): Promise<void> {
    while (!this.#abort.signal.aborted) {
      await delay(this.#pollIntervalMs, undefined, { signal: this.#abort.signal }).catch(
        () => undefined,
      );
      if (this.#abort.signal.aborted) break;
      await this.#refresh().catch(() => undefined);
    }
  }

  async #refresh(): Promise<void> {
    const response = await fetch(this.#controlPlaneUrl, {
      method: "GET",
      headers: { "x-agent-dock-internal-token": this.#serviceToken },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Cube egress configuration endpoint was unavailable");
    }
    const body = (await response.json()) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error("Cube egress configuration response was invalid");
    }
    const value = body as Record<string, unknown>;
    if (
      typeof value.enabled !== "boolean" ||
      !Number.isSafeInteger(value.revision) ||
      (value.revision as number) < 0 ||
      (value.upstreamProxyUrl !== undefined && typeof value.upstreamProxyUrl !== "string")
    ) {
      throw new Error("Cube egress configuration response was invalid");
    }
    let upstreamProxyUrl: URL | undefined;
    if (typeof value.upstreamProxyUrl === "string") {
      upstreamProxyUrl = new URL(value.upstreamProxyUrl);
      if (
        (upstreamProxyUrl.protocol !== "http:" && upstreamProxyUrl.protocol !== "https:") ||
        upstreamProxyUrl.username.length > 0 ||
        upstreamProxyUrl.password.length > 0 ||
        upstreamProxyUrl.pathname !== "/" ||
        upstreamProxyUrl.search.length > 0 ||
        upstreamProxyUrl.hash.length > 0
      ) {
        throw new Error("Cube egress configuration response was invalid");
      }
    }
    if (value.enabled && upstreamProxyUrl === undefined) {
      throw new Error("Cube egress configuration response was incomplete");
    }
    this.#current = Object.freeze({
      enabled: value.enabled,
      ...(upstreamProxyUrl === undefined ? {} : { upstreamProxyUrl }),
      revision: value.revision as number,
    });
  }
}
