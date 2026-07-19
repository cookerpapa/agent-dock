import type { Database } from "@agent-dock/database";
import type { Transaction } from "kysely";

export type SessionEventNotification = {
  schemaVersion: 1;
  tenantId: string;
  sessionId: string;
  throughSequence: number;
};

export type SessionEventNotificationHandlers = {
  onNotification(notification: SessionEventNotification): void;
  onResync(): void;
};

export interface SessionEventNotificationPublisher {
  publish(
    transaction: Transaction<Database>,
    notification: SessionEventNotification,
  ): Promise<void>;
}

export interface SessionEventNotificationTransport extends SessionEventNotificationPublisher {
  start(handlers: SessionEventNotificationHandlers): Promise<void>;
  stop(): Promise<void>;
}
