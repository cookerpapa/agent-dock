import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { SessionEventHub } from "./session-event-hub.ts";
import {
  KafkaAcceptedAgentEventConsumer,
  KafkaAcceptedAgentEventProducer,
  KafkaAgentEventAuthorityProjector,
  KafkaTerminalEventOutboxRelay,
  PostgresAgentEventAuthority,
} from "./kafka-agent-event-log.ts";
import {
  KafkaLiveEventStore,
  KafkaLiveTurnSnapshotSource,
  KafkaTerminalTurnProjectionSource,
} from "./kafka-live-event-store.ts";
import { KafkaPiSessionMutationProjector } from "./kafka-pi-session-mutations.ts";

export type KafkaFirstAgentEventRuntimeOptions = Readonly<{
  database: Kysely<Database>;
  brokers: readonly string[];
  rawTopic: string;
  acceptedTopic: string;
  sessionMutationTopic: string;
  instanceId: string;
  authorityGroupId?: string;
}>;

/** Owns the Kafka hot-event data plane for one Control Plane replica. */
export class KafkaFirstAgentEventRuntime {
  readonly eventHub: SessionEventHub;
  readonly eventStore: KafkaLiveEventStore;
  readonly liveTurnSnapshotSource: KafkaLiveTurnSnapshotSource;
  readonly terminalTurnProjectionSource: KafkaTerminalTurnProjectionSource;
  readonly #acceptedProducer: KafkaAcceptedAgentEventProducer;
  readonly #acceptedConsumer: KafkaAcceptedAgentEventConsumer;
  readonly #authorityProjector: KafkaAgentEventAuthorityProjector;
  readonly #terminalRelay: KafkaTerminalEventOutboxRelay;
  readonly #sessionMutationProjector: KafkaPiSessionMutationProjector;
  #started = false;

  constructor(options: KafkaFirstAgentEventRuntimeOptions) {
    this.eventHub = new SessionEventHub();
    this.eventStore = new KafkaLiveEventStore({
      database: options.database,
      eventHub: this.eventHub,
    });
    this.liveTurnSnapshotSource = new KafkaLiveTurnSnapshotSource({
      database: options.database,
      events: this.eventStore,
    });
    this.terminalTurnProjectionSource = new KafkaTerminalTurnProjectionSource({
      events: this.eventStore,
    });
    this.#acceptedProducer = new KafkaAcceptedAgentEventProducer({
      brokers: options.brokers,
      clientId: `${options.instanceId}-accepted-producer`,
      topic: options.acceptedTopic,
    });
    this.#authorityProjector = new KafkaAgentEventAuthorityProjector({
      brokers: options.brokers,
      clientId: `${options.instanceId}-authority`,
      topic: options.rawTopic,
      groupId: options.authorityGroupId ?? "pi-cloud-agent-event-authority-v1",
      authority: new PostgresAgentEventAuthority({ database: options.database }),
      accepted: this.#acceptedProducer,
    });
    this.#acceptedConsumer = new KafkaAcceptedAgentEventConsumer({
      brokers: options.brokers,
      clientId: `${options.instanceId}-gateway`,
      topic: options.acceptedTopic,
      // Every Gateway replica needs the complete retained suffix in its own
      // bounded projection; sharing a group would split Sessions between replicas.
      groupId: `pi-cloud-event-gateway-${options.instanceId}`,
      onEnvelopeGroup: async (values) => {
        for (const { envelope } of values) this.eventStore.append(envelope);
      },
    });
    this.#terminalRelay = new KafkaTerminalEventOutboxRelay({
      database: options.database,
      accepted: this.#acceptedProducer,
    });
    this.#sessionMutationProjector = new KafkaPiSessionMutationProjector({
      database: options.database,
      brokers: options.brokers,
      clientId: `${options.instanceId}-session-projector`,
      topic: options.sessionMutationTopic,
      groupId: "pi-cloud-session-mutation-projector-v1",
    });
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error("Kafka-first Agent event runtime can only start once");
    await this.#acceptedProducer.checkHealth();
    await this.#acceptedConsumer.start();
    await this.#authorityProjector.start();
    await this.#sessionMutationProjector.start();
    this.#terminalRelay.start();
    this.#started = true;
  }

  checkHealth(): void {
    if (!this.#started) throw new Error("Kafka-first Agent event runtime is not running");
    this.#acceptedConsumer.checkHealth();
    this.#authorityProjector.checkHealth();
    this.#sessionMutationProjector.checkHealth();
    this.#terminalRelay.checkHealth();
  }

  async close(): Promise<void> {
    if (!this.#started) {
      await this.#acceptedProducer.close();
      return;
    }
    this.#started = false;
    await this.#terminalRelay.close();
    await this.#authorityProjector.close();
    await this.#sessionMutationProjector.close();
    await this.#acceptedConsumer.close();
    await this.#acceptedProducer.close();
    this.eventHub.onApplicationShutdown();
  }
}
