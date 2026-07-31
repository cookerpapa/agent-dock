import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { MAX_PI_SESSION_SNAPSHOT_BYTES, MAX_WORKSPACE_SNAPSHOT_BYTES } from "@agent-dock/protocol";
import { createHash } from "node:crypto";

import {
  SandboxCheckpointStoreError,
  validateCheckpointObjectKey,
  type CheckpointObjectStore,
} from "./checkpoint-store.ts";

const MAX_CHECKPOINT_OBJECT_BYTES = Math.max(
  MAX_PI_SESSION_SNAPSHOT_BYTES,
  MAX_WORKSPACE_SNAPSHOT_BYTES,
);

type S3Credentials = NonNullable<S3ClientConfig["credentials"]>;

export type S3CheckpointObjectStoreOptions = {
  bucket: string;
  region: string;
  endpoint?: string;
  keyPrefix?: string;
  forcePathStyle?: boolean;
  allowInsecureEndpoint?: boolean;
  credentials?: S3Credentials;
  maxAttempts?: number;
};

export type S3CheckpointEnvironment = Readonly<Record<string, string | undefined>>;

type S3Operation = "put" | "get" | "delete" | "head";

type ErrorDetails = {
  name?: string;
  statusCode?: number;
};

function invalidObject(safeMessage: string): SandboxCheckpointStoreError {
  return new SandboxCheckpointStoreError("checkpoint_object_invalid", safeMessage, false);
}

function validateBucket(value: string): string {
  if (
    value.length < 3 ||
    value.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value) ||
    value.includes("..") ||
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)
  ) {
    throw new TypeError("S3 checkpoint bucket name is invalid");
  }
  return value;
}

function validateRegion(value: string): string {
  if (value.length < 1 || value.length > 128 || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new TypeError("S3 checkpoint region is invalid");
  }
  return value;
}

function validateEndpoint(value: string, allowInsecure: boolean): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError("S3 checkpoint endpoint is invalid");
  }
  if (
    (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0
  ) {
    throw new TypeError("S3 checkpoint endpoint is invalid");
  }
  if (endpoint.protocol === "http:" && !allowInsecure) {
    throw new TypeError("Plain HTTP S3 checkpoint endpoints require explicit opt-in");
  }
  return endpoint.toString();
}

function validateMaxAttempts(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10) {
    throw new TypeError("S3 checkpoint maxAttempts must be an integer from 1 to 10");
  }
  return value;
}

function requiredEnvironment(environment: S3CheckpointEnvironment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new TypeError(`Required S3 checkpoint environment variable ${name} is missing`);
  }
  return value;
}

function optionalEnvironment(
  environment: S3CheckpointEnvironment,
  name: string,
): string | undefined {
  const value = environment[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

function optionalBooleanEnvironment(
  environment: S3CheckpointEnvironment,
  name: string,
): boolean | undefined {
  const value = optionalEnvironment(environment, name);
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`${name} must be either true or false`);
}

function optionalIntegerEnvironment(
  environment: S3CheckpointEnvironment,
  name: string,
): number | undefined {
  const value = optionalEnvironment(environment, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`${name} must be an integer`);
  }
  return parsed;
}

function detailsFor(error: unknown): ErrorDetails {
  if (typeof error !== "object" || error === null) return {};
  const record = error as Record<string, unknown>;
  const metadata = record["$metadata"];
  let statusCode: number | undefined;
  if (typeof metadata === "object" && metadata !== null) {
    const candidate = (metadata as Record<string, unknown>)["httpStatusCode"];
    if (typeof candidate === "number" && Number.isSafeInteger(candidate)) {
      statusCode = candidate;
    }
  }
  return {
    ...(typeof record["name"] === "string" ? { name: record["name"] } : {}),
    ...(statusCode === undefined ? {} : { statusCode }),
  };
}

function isMissing(error: unknown): boolean {
  const details = detailsFor(error);
  return details.statusCode === 404 || details.name === "NoSuchKey" || details.name === "NotFound";
}

function isChecksumFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  return (
    (typeof record["name"] === "string" && /checksum/i.test(record["name"])) ||
    (typeof record["message"] === "string" && /checksum/i.test(record["message"]))
  );
}

function translateS3Error(operation: S3Operation, error: unknown): SandboxCheckpointStoreError {
  if (error instanceof SandboxCheckpointStoreError) return error;
  const details = detailsFor(error);

  if (operation === "get" && isChecksumFailure(error)) {
    return new SandboxCheckpointStoreError(
      "checkpoint_object_checksum_mismatch",
      "Checkpoint object checksum did not match",
      false,
    );
  }

  if (operation === "put" && details.statusCode === 412) {
    return new SandboxCheckpointStoreError(
      "checkpoint_object_exists",
      "Checkpoint object already exists",
      false,
    );
  }
  if (operation === "put" && details.statusCode === 409) {
    return new SandboxCheckpointStoreError(
      "checkpoint_object_write_conflict",
      "Checkpoint object write conflicted and may be retried",
      true,
    );
  }
  if (operation === "get" && isMissing(error)) {
    return new SandboxCheckpointStoreError(
      "checkpoint_object_missing",
      "Checkpoint object is missing",
      false,
    );
  }
  if (details.statusCode === 401 || details.statusCode === 403) {
    return new SandboxCheckpointStoreError(
      "checkpoint_object_store_forbidden",
      "Checkpoint object store rejected authorization",
      false,
    );
  }
  if (details.statusCode === 400) {
    return new SandboxCheckpointStoreError(
      "checkpoint_object_store_rejected",
      "Checkpoint object store rejected the request",
      false,
    );
  }
  const retryable =
    details.statusCode === undefined ||
    details.statusCode === 408 ||
    details.statusCode === 429 ||
    details.statusCode >= 500;
  return new SandboxCheckpointStoreError(
    retryable ? "checkpoint_object_store_unavailable" : "checkpoint_object_store_rejected",
    retryable
      ? "Checkpoint object store is temporarily unavailable"
      : "Checkpoint object store rejected the request",
    retryable,
  );
}

function validateBytes(bytes: Uint8Array): Buffer {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_CHECKPOINT_OBJECT_BYTES
  ) {
    throw invalidObject("Checkpoint object is outside its byte limit");
  }
  return Buffer.from(bytes);
}

function declaredLength(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CHECKPOINT_OBJECT_BYTES) {
    throw invalidObject("Checkpoint object is outside its byte limit");
  }
  return value;
}

function abortBody(body: unknown): void {
  if (typeof body !== "object" || body === null) return;
  const stream = body as { destroy?: unknown; on?: unknown };
  if (typeof stream.on === "function") {
    stream.on.call(body, "error", () => undefined);
  }
  const destroy = stream.destroy;
  if (typeof destroy !== "function") return;
  try {
    destroy.call(body);
  } catch {
    // The original bounded-read failure remains authoritative.
  }
}

async function readBoundedBody(body: unknown, expectedLength: number | undefined): Promise<Buffer> {
  if (typeof body !== "object" || body === null) {
    throw invalidObject("Checkpoint object has no readable body");
  }
  const iterator = (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
  if (typeof iterator !== "function") {
    throw invalidObject("Checkpoint object has no readable body");
  }

  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of body as AsyncIterable<unknown>) {
    if (!(chunk instanceof Uint8Array)) {
      abortBody(body);
      throw invalidObject("Checkpoint object returned an invalid body");
    }
    length += chunk.byteLength;
    if (length > MAX_CHECKPOINT_OBJECT_BYTES) {
      abortBody(body);
      throw invalidObject("Checkpoint object is outside its byte limit");
    }
    chunks.push(Buffer.from(chunk));
  }
  if (length < 1 || (expectedLength !== undefined && expectedLength !== length)) {
    throw invalidObject("Checkpoint object length did not match its metadata");
  }
  return Buffer.concat(chunks, length);
}

function sha256Base64(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64");
}

export class S3CheckpointObjectStore implements CheckpointObjectStore {
  readonly #bucket: string;
  readonly #client: S3Client;
  readonly #keyPrefix: string;

  constructor(options: S3CheckpointObjectStoreOptions) {
    this.#bucket = validateBucket(options.bucket);
    const region = validateRegion(options.region);
    const keyPrefix = options.keyPrefix ?? "";
    this.#keyPrefix = keyPrefix.length === 0 ? "" : validateCheckpointObjectKey(keyPrefix);
    const endpoint =
      options.endpoint === undefined
        ? undefined
        : validateEndpoint(options.endpoint, options.allowInsecureEndpoint === true);
    if (options.allowInsecureEndpoint === true && endpoint === undefined) {
      throw new TypeError("allowInsecureEndpoint requires a custom S3 checkpoint endpoint");
    }
    const clientConfiguration: S3ClientConfig = {
      region,
      forcePathStyle: options.forcePathStyle ?? endpoint !== undefined,
      maxAttempts: validateMaxAttempts(options.maxAttempts ?? 3),
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    };
    this.#client = new S3Client(clientConfiguration);
  }

  async put(objectKey: string, bytes: Uint8Array): Promise<void> {
    const key = this.#physicalKey(objectKey);
    const body = validateBytes(bytes);
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: body,
          ContentLength: body.byteLength,
          ContentType: "application/octet-stream",
          IfNoneMatch: "*",
          ChecksumSHA256: sha256Base64(body),
        }),
      );
    } catch (error: unknown) {
      throw translateS3Error("put", error);
    }
  }

  async get(objectKey: string): Promise<Uint8Array> {
    const key = this.#physicalKey(objectKey);
    try {
      const response = await this.#client.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          ChecksumMode: "ENABLED",
        }),
      );
      let expectedLength: number | undefined;
      try {
        expectedLength = declaredLength(response.ContentLength);
      } catch (error: unknown) {
        abortBody(response.Body);
        throw error;
      }
      const bytes = await readBoundedBody(response.Body, expectedLength);
      if (
        response.ChecksumSHA256 !== undefined &&
        response.ChecksumSHA256 !== sha256Base64(bytes)
      ) {
        throw new SandboxCheckpointStoreError(
          "checkpoint_object_checksum_mismatch",
          "Checkpoint object checksum did not match",
          false,
        );
      }
      return bytes;
    } catch (error: unknown) {
      throw translateS3Error("get", error);
    }
  }

  async delete(objectKey: string): Promise<void> {
    const key = this.#physicalKey(objectKey);
    try {
      await this.#client.send(
        new DeleteObjectCommand({
          Bucket: this.#bucket,
          Key: key,
        }),
      );
    } catch (error: unknown) {
      if (isMissing(error)) return;
      throw translateS3Error("delete", error);
    }
  }

  async checkHealth(): Promise<void> {
    try {
      await this.#client.send(new HeadBucketCommand({ Bucket: this.#bucket }));
    } catch (error: unknown) {
      throw translateS3Error("head", error);
    }
  }

  destroy(): void {
    this.#client.destroy();
  }

  #physicalKey(objectKey: string): string {
    const logicalKey = validateCheckpointObjectKey(objectKey);
    return validateCheckpointObjectKey(
      this.#keyPrefix.length === 0 ? logicalKey : `${this.#keyPrefix}/${logicalKey}`,
    );
  }
}

export function createS3CheckpointObjectStoreFromEnvironment(
  environment: S3CheckpointEnvironment = process.env,
): S3CheckpointObjectStore {
  const endpoint = optionalEnvironment(environment, "AGENT_DOCK_CHECKPOINT_S3_ENDPOINT");
  const keyPrefix = optionalEnvironment(environment, "AGENT_DOCK_CHECKPOINT_S3_KEY_PREFIX");
  const forcePathStyle = optionalBooleanEnvironment(
    environment,
    "AGENT_DOCK_CHECKPOINT_S3_FORCE_PATH_STYLE",
  );
  const allowInsecureEndpoint = optionalBooleanEnvironment(
    environment,
    "AGENT_DOCK_CHECKPOINT_S3_ALLOW_INSECURE_ENDPOINT",
  );
  const maxAttempts = optionalIntegerEnvironment(
    environment,
    "AGENT_DOCK_CHECKPOINT_S3_MAX_ATTEMPTS",
  );
  const region =
    optionalEnvironment(environment, "AGENT_DOCK_CHECKPOINT_S3_REGION") ??
    optionalEnvironment(environment, "AWS_REGION") ??
    optionalEnvironment(environment, "AWS_DEFAULT_REGION");
  if (region === undefined) {
    throw new TypeError(
      "Required S3 checkpoint region is missing; set AGENT_DOCK_CHECKPOINT_S3_REGION or AWS_REGION",
    );
  }
  return new S3CheckpointObjectStore({
    bucket: requiredEnvironment(environment, "AGENT_DOCK_CHECKPOINT_S3_BUCKET"),
    region,
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(keyPrefix === undefined ? {} : { keyPrefix }),
    ...(forcePathStyle === undefined ? {} : { forcePathStyle }),
    ...(allowInsecureEndpoint === undefined ? {} : { allowInsecureEndpoint }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  });
}
