import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { GitHubGatewayError, positiveSafeInteger, type GitHubWebhookEvent } from "./types.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  try {
    return positiveSafeInteger(value, "webhook identifier");
  } catch {
    return undefined;
  }
}

export function verifyGitHubWebhook(
  secret: string,
  rawBody: Uint8Array,
  signatureHeader: string | undefined,
): void {
  if (!/^[\x21-\x7e]{32,4096}$/.test(secret)) throw new TypeError("Webhook secret is invalid");
  const match = /^sha256=([0-9a-f]{64})$/.exec(signatureHeader ?? "");
  const supplied = match?.[1] === undefined ? Buffer.alloc(32) : Buffer.from(match[1], "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  if (match === null || !timingSafeEqual(expected, supplied)) {
    throw new GitHubGatewayError(
      "invalid_webhook_signature",
      "Webhook signature is invalid",
      false,
    );
  }
}

export function normalizeGitHubWebhook(
  deliveryId: string,
  eventName: string,
  rawBody: Uint8Array,
): GitHubWebhookEvent {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(deliveryId) || !/^[a-z_]{1,64}$/.test(eventName)) {
    throw new GitHubGatewayError("invalid_webhook_headers", "Webhook headers are invalid", false);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(rawBody).toString("utf8")) as unknown;
  } catch {
    throw new GitHubGatewayError("invalid_webhook_payload", "Webhook payload is invalid", false);
  }
  const root = record(payload);
  if (root === undefined) {
    throw new GitHubGatewayError("invalid_webhook_payload", "Webhook payload is invalid", false);
  }
  const installation = record(root.installation);
  const repository = record(root.repository);
  const account = record(installation?.account) ?? record(root.sender);
  return {
    deliveryId,
    eventName,
    payloadSha256: createHash("sha256").update(rawBody).digest("hex"),
    ...(typeof root.action === "string" && root.action.length <= 64 ? { action: root.action } : {}),
    ...(optionalInteger(installation?.id) === undefined
      ? {}
      : { installationId: optionalInteger(installation?.id)! }),
    ...(optionalInteger(repository?.id) === undefined
      ? {}
      : { repositoryId: optionalInteger(repository?.id)! }),
    ...(typeof repository?.full_name === "string" && repository.full_name.length <= 256
      ? { repositoryFullName: repository.full_name }
      : {}),
    ...(typeof account?.login === "string" && account.login.length <= 128
      ? { accountLogin: account.login }
      : {}),
  };
}
