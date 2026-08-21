import {
  TERMINAL_TURN_PROJECTION_PATH,
  type PrepareTerminalTurnProjectionInput,
  type TerminalTurnProjectionSource,
} from "@pi-cloud/runtime-core/terminal-turn-projection";
import type { FastifyInstance } from "fastify";

export class TerminalTurnProjectionGateway {
  readonly #source: TerminalTurnProjectionSource;
  readonly #authorize: (authorization: string | undefined) => void;
  #installed = false;

  constructor(options: {
    source: TerminalTurnProjectionSource;
    authorize(authorization: string | undefined): void;
  }) {
    this.#source = options.source;
    this.#authorize = options.authorize;
  }

  install(fastify: FastifyInstance): void {
    if (this.#installed) throw new Error("Terminal projection gateway is already installed");
    this.#installed = true;
    fastify.post(
      TERMINAL_TURN_PROJECTION_PATH,
      { bodyLimit: 16 * 1024 * 1024 },
      async (request, reply) => {
        try {
          this.#authorize(request.headers.authorization);
          const input = request.body as PrepareTerminalTurnProjectionInput;
          if (
            typeof input !== "object" ||
            input === null ||
            typeof input.tenantId !== "string" ||
            typeof input.sessionId !== "string" ||
            typeof input.turnId !== "string" ||
            typeof input.commandId !== "string" ||
            typeof input.eventId !== "string" ||
            typeof input.occurredAt !== "string" ||
            typeof input.body !== "object" ||
            input.body === null
          ) {
            await reply
              .code(400)
              .send({ error: { code: "invalid_request", message: "Invalid request" } });
            return;
          }
          await reply.code(200).send(await this.#source.prepare(input));
        } catch (error: unknown) {
          const unauthorized =
            typeof error === "object" &&
            error !== null &&
            "statusCode" in error &&
            error.statusCode === 401;
          await reply.code(unauthorized ? 401 : 503).send({
            error: {
              code: unauthorized ? "unauthorized" : "projection_unavailable",
              message: unauthorized ? "Unauthorized" : "Terminal projection is unavailable",
            },
          });
        }
      },
    );
  }
}
