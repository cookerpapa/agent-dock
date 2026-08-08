import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

const requestedPort = Number(process.argv[2] ?? "0");
const holdEventAcknowledgements = process.argv[3] === "hold-event-ack";
if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
  throw new Error("Control Channel fixture port is invalid");
}

const server = new WebSocketServer({ host: "127.0.0.1", port: requestedPort });
server.on("connection", (socket) => {
  let connectionId;
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    if (message.type === "supervisor.register") {
      connectionId = randomUUID();
      socket.send(
        JSON.stringify({
          protocolVersion: 1,
          messageId: randomUUID(),
          sentAt: new Date().toISOString(),
          type: "supervisor.registered",
          payload: {
            supervisorId: message.payload.supervisorId,
            bootId: message.payload.bootId,
            connectionId,
            selectedProtocolVersion: 1,
            heartbeatIntervalMs: 40,
            heartbeatTimeoutMs: 1_000,
            serverTime: new Date().toISOString(),
          },
        }),
      );
      return;
    }
    if (message.type === "supervisor.heartbeat" && connectionId !== undefined) {
      socket.send(
        JSON.stringify({
          protocolVersion: 1,
          messageId: randomUUID(),
          sentAt: new Date().toISOString(),
          type: "supervisor.heartbeat.ack",
          payload: {
            acknowledgedMessageId: message.messageId,
            connectionId,
            leaseRenewals: [],
          },
        }),
      );
      return;
    }
    if (
      (message.type === "event.publish" || message.type === "event.publish_batch") &&
      connectionId !== undefined
    ) {
      const event =
        message.type === "event.publish" ? message.payload.event : message.payload.events.at(-1);
      process.send?.({ type: "event_received", sequence: event.seq });
      if (holdEventAcknowledgements) return;
      socket.send(
        JSON.stringify({
          protocolVersion: 1,
          messageId: randomUUID(),
          sentAt: new Date().toISOString(),
          type: "event.ack",
          payload: {
            sessionId: event.sessionId,
            leaseId: message.payload.leaseId,
            fencingToken: message.payload.fencingToken,
            acknowledgedThroughSeq: event.seq,
          },
        }),
      );
    }
  });
});

server.once("listening", () => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Fixture address missing");
  process.send?.({ type: "ready", port: address.port });
});
