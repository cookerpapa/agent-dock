import type { Database } from "@agent-dock/database";
import type { GitHubWebhookEvent } from "@agent-dock/github-gateway";
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";

export const CONTROL_PLANE_GITHUB_WEBHOOK_PATH = "/internal/v1/github/webhook-events";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function bearer(value: string | undefined): string | undefined {
  return /^Bearer ([A-Za-z0-9._~+/=-]{32,4096})$/.exec(value ?? "")?.[1];
}

function event(value: unknown): GitHubWebhookEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Webhook event is invalid");
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.deliveryId !== "string" ||
    !/^[A-Za-z0-9-]{1,128}$/.test(row.deliveryId) ||
    typeof row.eventName !== "string" ||
    !/^[a-z_]{1,64}$/.test(row.eventName) ||
    typeof row.payloadSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.payloadSha256)
  ) {
    throw new TypeError("Webhook event is invalid");
  }
  const positive = (input: unknown): input is number =>
    typeof input === "number" && Number.isSafeInteger(input) && input > 0;
  return {
    deliveryId: row.deliveryId,
    eventName: row.eventName,
    payloadSha256: row.payloadSha256,
    ...(typeof row.action === "string" && row.action.length <= 64 ? { action: row.action } : {}),
    ...(positive(row.installationId) ? { installationId: row.installationId } : {}),
    ...(positive(row.repositoryId) ? { repositoryId: row.repositoryId } : {}),
    ...(typeof row.repositoryFullName === "string" && row.repositoryFullName.length <= 256
      ? { repositoryFullName: row.repositoryFullName }
      : {}),
    ...(typeof row.accountLogin === "string" && row.accountLogin.length <= 128
      ? { accountLogin: row.accountLogin }
      : {}),
  };
}

export class GitHubWebhookIngestGateway {
  readonly #database: Kysely<Database>;
  readonly #tokenDigest: Buffer;
  #installed = false;

  constructor(options: { database: Kysely<Database>; serviceToken: string }) {
    if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(options.serviceToken)) {
      throw new TypeError("GitHub webhook service token is invalid");
    }
    this.#database = options.database;
    this.#tokenDigest = digest(options.serviceToken);
  }

  install(fastify: FastifyInstance): void {
    if (this.#installed) throw new Error("GitHub webhook gateway is already installed");
    this.#installed = true;
    fastify.post(CONTROL_PLANE_GITHUB_WEBHOOK_PATH, async (request, reply) => {
      const token = bearer(request.headers.authorization);
      if (token === undefined || !timingSafeEqual(this.#tokenDigest, digest(token))) {
        await reply.code(401).send({
          error: {
            code: "invalid_service_credential",
            message: "Webhook ingest is not authorized",
          },
        });
        return;
      }
      try {
        const input = event(request.body);
        const result = await this.#database.transaction().execute(async (transaction) => {
          const existing = await transaction
            .selectFrom("github_webhook_deliveries")
            .select(["event_name", "payload_sha256", "status"])
            .where("delivery_id", "=", input.deliveryId)
            .executeTakeFirst();
          if (existing !== undefined) {
            if (
              existing.event_name !== input.eventName ||
              existing.payload_sha256 !== input.payloadSha256
            ) {
              throw new TypeError("Webhook delivery ID was reused with different content");
            }
            return { replayed: true, status: existing.status };
          }
          const installation =
            input.installationId === undefined
              ? undefined
              : await transaction
                  .selectFrom("github_app_installations")
                  .select("tenant_id")
                  .where("installation_id", "=", String(input.installationId))
                  .executeTakeFirst();
          const status = installation === undefined ? "ignored" : "processed";
          if (installation !== undefined && input.installationId !== undefined) {
            if (input.eventName === "installation" && input.action === "deleted") {
              await transaction
                .updateTable("github_app_installations")
                .set({ status: "removed", updated_at: new Date() })
                .where("tenant_id", "=", installation.tenant_id)
                .where("installation_id", "=", String(input.installationId))
                .execute();
            } else if (
              input.eventName === "installation" &&
              (input.action === "suspend" || input.action === "unsuspend")
            ) {
              await transaction
                .updateTable("github_app_installations")
                .set({
                  status: input.action === "suspend" ? "suspended" : "active",
                  suspended_at: input.action === "suspend" ? new Date() : null,
                  updated_at: new Date(),
                })
                .where("tenant_id", "=", installation.tenant_id)
                .where("installation_id", "=", String(input.installationId))
                .execute();
            }
            if (
              input.repositoryId !== undefined &&
              ((input.eventName === "repository" && input.action === "deleted") ||
                (input.eventName === "installation_repositories" && input.action === "removed"))
            ) {
              await transaction
                .updateTable("github_repositories")
                .set({ enabled: false, updated_at: new Date() })
                .where("tenant_id", "=", installation.tenant_id)
                .where("repository_id", "=", String(input.repositoryId))
                .execute();
            }
          }
          await transaction
            .insertInto("github_webhook_deliveries")
            .values({
              delivery_id: input.deliveryId,
              event_name: input.eventName,
              payload_sha256: input.payloadSha256,
              tenant_id: installation?.tenant_id ?? null,
              installation_id: input.installationId ?? null,
              status,
              failure_code: null,
              processed_at: new Date(),
            })
            .executeTakeFirstOrThrow();
          return { replayed: false, status };
        });
        await reply.code(202).send({ accepted: true, deliveryId: input.deliveryId, ...result });
      } catch {
        await reply.code(409).send({
          error: { code: "webhook_event_conflict", message: "Webhook event was rejected" },
        });
      }
    });
  }
}
