import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer } from "node:http";

import {
  createS3CheckpointObjectStoreFromEnvironment,
  S3CheckpointObjectStore,
  SandboxCheckpointStoreError,
  type S3CheckpointObjectStoreOptions,
} from "../src/index.ts";

const credentials = {
  accessKeyId: "x".repeat(20),
  secretAccessKey: "y".repeat(40),
};

function options(
  overrides: Partial<S3CheckpointObjectStoreOptions> = {},
): S3CheckpointObjectStoreOptions {
  return {
    bucket: "agent-dock-checkpoints",
    region: "us-east-1",
    endpoint: "http://127.0.0.1:1",
    allowInsecureEndpoint: true,
    credentials,
    maxAttempts: 1,
    ...overrides,
  };
}

describe("S3 checkpoint object store", () => {
  it("builds deployment configuration without introducing a custom credential channel", () => {
    const store = createS3CheckpointObjectStoreFromEnvironment({
      AGENT_DOCK_CHECKPOINT_S3_BUCKET: "agent-dock-checkpoints",
      AWS_REGION: "us-east-1",
      AGENT_DOCK_CHECKPOINT_S3_KEY_PREFIX: "production/v1",
      AGENT_DOCK_CHECKPOINT_S3_MAX_ATTEMPTS: "4",
    });
    store.destroy();

    expect(() => createS3CheckpointObjectStoreFromEnvironment({ AWS_REGION: "us-east-1" })).toThrow(
      "AGENT_DOCK_CHECKPOINT_S3_BUCKET",
    );
    expect(() =>
      createS3CheckpointObjectStoreFromEnvironment({
        AGENT_DOCK_CHECKPOINT_S3_BUCKET: "agent-dock-checkpoints",
        AWS_REGION: "us-east-1",
        AGENT_DOCK_CHECKPOINT_S3_ENDPOINT: "http://127.0.0.1:9000",
      }),
    ).toThrow("explicit opt-in");
    expect(() =>
      createS3CheckpointObjectStoreFromEnvironment({
        AGENT_DOCK_CHECKPOINT_S3_BUCKET: "agent-dock-checkpoints",
        AWS_REGION: "us-east-1",
        AGENT_DOCK_CHECKPOINT_S3_FORCE_PATH_STYLE: "yes",
      }),
    ).toThrow("must be either true or false");
  });

  it("rejects unsafe deployment configuration before constructing a client", () => {
    expect(() => new S3CheckpointObjectStore(options({ bucket: "Bad_Bucket" }))).toThrow(
      "bucket name is invalid",
    );
    expect(
      () =>
        new S3CheckpointObjectStore(
          options({ endpoint: "http://127.0.0.1:9000", allowInsecureEndpoint: false }),
        ),
    ).toThrow("require explicit opt-in");
    expect(
      () => new S3CheckpointObjectStore(options({ endpoint: "https://user:pass@example.test" })),
    ).toThrow("endpoint is invalid");
    expect(() => new S3CheckpointObjectStore(options({ keyPrefix: "../escape" }))).toThrow(
      "Checkpoint object key is invalid",
    );
    expect(() => new S3CheckpointObjectStore(options({ maxAttempts: 0 }))).toThrow("maxAttempts");
  });

  it("rejects invalid logical keys and byte sizes without contacting S3", async () => {
    const store = new S3CheckpointObjectStore(options({ keyPrefix: "tenant/checkpoints" }));
    try {
      await expect(store.get("../escape")).rejects.toMatchObject({
        code: "checkpoint_object_key_invalid",
        retryable: false,
      });
      await expect(store.put("valid/object.bin", new Uint8Array())).rejects.toMatchObject({
        code: "checkpoint_object_invalid",
        retryable: false,
      });
      await expect(
        store.put("valid/object.bin", Buffer.alloc(2 * 1_024 * 1_024 + 1)),
      ).rejects.toMatchObject({
        code: "checkpoint_object_invalid",
        retryable: false,
      });
    } finally {
      store.destroy();
    }
  });

  it("maps transport failures to a retryable error without leaking configuration", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 503;
      response.setHeader("content-type", "application/xml");
      response.end("<Error><Code>SlowDown</Code><Message>fixture</Message></Error>");
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("S3 error fixture did not bind a TCP port");
    }
    const endpoint = `http://127.0.0.1:${String(address.port)}`;
    const store = new S3CheckpointObjectStore(options({ endpoint }));
    try {
      let failure: unknown;
      try {
        await store.get("private/session-object");
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(SandboxCheckpointStoreError);
      expect(failure).toMatchObject({
        code: "checkpoint_object_store_unavailable",
        message: "Checkpoint object store is temporarily unavailable",
        retryable: true,
      });
      const rendered = String(failure);
      expect(rendered).not.toContain(endpoint);
      expect(rendered).not.toContain("private/session-object");
      expect(rendered).not.toContain(credentials.secretAccessKey);
    } finally {
      store.destroy();
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => {
          if (error) rejectPromise(error);
          else resolvePromise();
        });
      });
    }
  });

  it("maps an SDK or adapter checksum rejection to a closed non-retryable error", async () => {
    const body = Buffer.from("checkpoint");
    const wrongChecksum = createHash("sha256").update("different").digest("base64");
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader("content-type", "application/octet-stream");
      response.setHeader("content-length", String(body.byteLength));
      response.setHeader("x-amz-checksum-sha256", wrongChecksum);
      response.end(body);
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("S3 checksum fixture did not bind a TCP port");
    }
    const store = new S3CheckpointObjectStore(
      options({ endpoint: `http://127.0.0.1:${String(address.port)}` }),
    );
    try {
      await expect(store.get("checksums/mismatch.bin")).rejects.toMatchObject({
        code: "checkpoint_object_checksum_mismatch",
        message: "Checkpoint object checksum did not match",
        retryable: false,
      });
    } finally {
      store.destroy();
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => {
          if (error) rejectPromise(error);
          else resolvePromise();
        });
      });
    }
  });
});
