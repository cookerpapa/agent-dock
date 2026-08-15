import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@agent-dock/database";
import type {
  ConversationForkResource,
  ConversationTreeBranchResource,
  ConversationTreeEntryResource,
  ConversationTreeResource,
  ConversationTreeView,
  CreateConversationForkRequest,
} from "@agent-dock/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import { ControlPlaneStoreError } from "./control-plane-store.ts";

const MAX_TREE_BRANCHES = 100;
const MAX_TREE_ENTRIES = 10_000;

type SessionRow = {
  id: string;
  title: string;
  parentSessionId: string | null;
  forkTurnId: string | null;
  forkEntryId: string | null;
};

type PiEntryRow = {
  id: string;
  seq: string;
  parentId: string | null;
  type: string;
  customType: string | null;
  timestampMs: string;
  payload: Record<string, unknown>;
};

type CompletedTurnRow = {
  sessionId: string;
  turnId: string;
  mailboxPosition: string;
};

type MappedEntry = ConversationTreeEntryResource & { readonly index: number };

function safeInteger(value: string | number, description: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ControlPlaneStoreError("control_plane_misconfigured", `${description} is invalid`);
  }
  return parsed;
}

function messageFromPayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  const message = payload.message;
  return typeof message === "object" && message !== null && !Array.isArray(message)
    ? (message as Record<string, unknown>)
    : null;
}

function messageText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((part) => {
      if (typeof part !== "object" || part === null || Array.isArray(part)) return [];
      const value = part as Record<string, unknown>;
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("\n");
}

function isFinalAssistant(message: Record<string, unknown>): boolean {
  if (message.role !== "assistant" || typeof message.stopReason !== "string") return false;
  return !["toolUse", "error", "aborted", "pending"].includes(message.stopReason);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isoFromMilliseconds(value: string): string {
  const date = new Date(safeInteger(value, "Pi entry timestamp"));
  if (Number.isNaN(date.valueOf())) {
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      "Pi entry timestamp is invalid",
    );
  }
  return date.toISOString();
}

function activeBranch(rows: readonly PiEntryRow[], leafId: string | null): PiEntryRow[] {
  if (leafId === null) return [];
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const reversed: PiEntryRow[] = [];
  const seen = new Set<string>();
  let cursor: string | null = leafId;
  while (cursor !== null) {
    if (seen.has(cursor)) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Pi Session tree contains a cycle",
      );
    }
    seen.add(cursor);
    const row = byId.get(cursor);
    if (row === undefined) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Pi Session tree has a missing parent",
      );
    }
    reversed.push(row);
    cursor = row.parentId;
  }
  return reversed.reverse();
}

function ownBranch(branch: readonly PiEntryRow[], forkEntryId: string | null): PiEntryRow[] {
  if (forkEntryId === null) return [...branch];
  const anchor = branch.findIndex((entry) => entry.id === forkEntryId);
  if (anchor < 0) {
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      "Fork anchor is missing from the child Pi Session",
    );
  }
  return branch.slice(anchor + 1);
}

function mappedConversationEntries(
  branch: readonly PiEntryRow[],
  turns: readonly CompletedTurnRow[],
): MappedEntry[] {
  const finals = branch.flatMap((entry, index) => {
    if (entry.type !== "message") return [];
    const message = messageFromPayload(entry.payload);
    return message !== null && isFinalAssistant(message) ? [{ entry, index, message }] : [];
  });
  const pairCount = Math.min(finals.length, turns.length);
  const pairedFinals = finals.slice(finals.length - pairCount);
  const pairedTurns = turns.slice(turns.length - pairCount);
  const result: MappedEntry[] = [];
  let previousFinalIndex = -1;
  for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
    const final = pairedFinals[pairIndex]!;
    const turn = pairedTurns[pairIndex]!;
    const user = branch.slice(previousFinalIndex + 1, final.index).find((entry) => {
      if (entry.type !== "message") return false;
      return messageFromPayload(entry.payload)?.role === "user";
    });
    if (user !== undefined) {
      const userMessage = messageFromPayload(user.payload)!;
      result.push({
        entryId: user.id,
        parentEntryId: user.parentId,
        turnId: turn.turnId,
        role: "user",
        text: messageText(userMessage),
        finalAssistant: false,
        createdAt: isoFromMilliseconds(user.timestampMs),
        index: branch.indexOf(user),
      });
    }
    result.push({
      entryId: final.entry.id,
      parentEntryId: final.entry.parentId,
      turnId: turn.turnId,
      role: "assistant",
      text: messageText(final.message),
      finalAssistant: true,
      createdAt: isoFromMilliseconds(final.entry.timestampMs),
      index: final.index,
    });
    previousFinalIndex = final.index;
  }
  return result;
}

async function sessionEntries(
  database: Kysely<Database> | Transaction<Database>,
  tenantId: string,
  sessionIds: readonly string[],
): Promise<Map<string, PiEntryRow[]>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await database
    .selectFrom("pi_session_entries")
    .select([
      "session_id",
      "id",
      "seq",
      "parent_id",
      "type",
      "custom_type",
      "timestamp_ms",
      "payload",
    ])
    .where("tenant_id", "=", tenantId)
    .where("session_id", "in", sessionIds)
    .orderBy("session_id")
    .orderBy("seq")
    .execute();
  const grouped = new Map<string, PiEntryRow[]>();
  for (const row of rows) {
    const entries = grouped.get(row.session_id) ?? [];
    entries.push({
      id: row.id,
      seq: row.seq,
      parentId: row.parent_id,
      type: row.type,
      customType: row.custom_type,
      timestampMs: row.timestamp_ms,
      payload: row.payload,
    });
    grouped.set(row.session_id, entries);
  }
  return grouped;
}

async function completedTurns(
  database: Kysely<Database> | Transaction<Database>,
  tenantId: string,
  sessionIds: readonly string[],
): Promise<Map<string, CompletedTurnRow[]>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await database
    .selectFrom("commands as command")
    .innerJoin("turns as turn", (join) =>
      join
        .onRef("turn.tenant_id", "=", "command.tenant_id")
        .onRef("turn.id", "=", "command.turn_id"),
    )
    .select([
      "command.session_id as sessionId",
      "turn.id as turnId",
      "command.mailbox_position as mailboxPosition",
    ])
    .where("command.tenant_id", "=", tenantId)
    .where("command.session_id", "in", sessionIds)
    .where("command.kind", "=", "turn.execute")
    .where("command.mailbox_position", "is not", null)
    .where("turn.state", "=", "completed")
    .orderBy("command.session_id")
    .orderBy("command.mailbox_position")
    .execute();
  const grouped = new Map<string, CompletedTurnRow[]>();
  for (const row of rows) {
    if (row.mailboxPosition === null) continue;
    const turns = grouped.get(row.sessionId) ?? [];
    turns.push({
      sessionId: row.sessionId,
      turnId: row.turnId,
      mailboxPosition: row.mailboxPosition,
    });
    grouped.set(row.sessionId, turns);
  }
  return grouped;
}

async function mainLeaves(
  database: Kysely<Database> | Transaction<Database>,
  tenantId: string,
  sessionIds: readonly string[],
): Promise<Map<string, string | null>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await database
    .selectFrom("pi_session_lanes")
    .select(["session_id", "leaf_id"])
    .where("tenant_id", "=", tenantId)
    .where("session_id", "in", sessionIds)
    .where("lane", "=", "main")
    .execute();
  return new Map(rows.map((row) => [row.session_id, row.leaf_id] as const));
}

export class ConversationTreeService {
  readonly #database: Kysely<Database>;
  readonly #idGenerator: () => string;

  constructor(options: { database: Kysely<Database>; idGenerator?: () => string }) {
    this.#database = options.database;
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  async tree(
    tenantId: string,
    currentSessionId: string,
    view: ConversationTreeView,
  ): Promise<ConversationTreeResource> {
    const lineage = await this.#lineage(tenantId, currentSessionId);
    const rootSessionId = lineage[0]!.id;
    const sessions = view === "focus" ? lineage : await this.#family(tenantId, rootSessionId);
    const sessionIds = sessions.map((session) => session.id);
    const [entriesBySession, turnsBySession, leaves] = await Promise.all([
      sessionEntries(this.#database, tenantId, sessionIds),
      completedTurns(this.#database, tenantId, sessionIds),
      mainLeaves(this.#database, tenantId, sessionIds),
    ]);
    let entryCount = 0;
    const branches: ConversationTreeBranchResource[] = sessions.map((session, index) => {
      const allEntries = entriesBySession.get(session.id) ?? [];
      const branch = ownBranch(
        activeBranch(allEntries, leaves.get(session.id) ?? null),
        session.forkEntryId,
      );
      let mapped = mappedConversationEntries(branch, turnsBySession.get(session.id) ?? []);
      if (view === "focus") {
        const child = sessions[index + 1];
        if (child?.parentSessionId === session.id && child.forkEntryId !== null) {
          const boundary = mapped.findIndex((entry) => entry.entryId === child.forkEntryId);
          if (boundary < 0) {
            throw new ControlPlaneStoreError(
              "control_plane_misconfigured",
              "Focused fork anchor is missing from its parent branch",
            );
          }
          mapped = mapped.slice(0, boundary + 1);
        }
      }
      entryCount += mapped.length;
      if (entryCount > MAX_TREE_ENTRIES) {
        throw new ControlPlaneStoreError("invalid_request", "Conversation tree is too large");
      }
      return {
        sessionId: session.id,
        title: session.title,
        parentSessionId: session.parentSessionId,
        forkedFromTurnId: session.forkTurnId,
        forkedFromEntryId: session.forkEntryId,
        current: session.id === currentSessionId,
        entries: mapped.map(({ index: _index, ...entry }) => entry),
      };
    });
    return { rootSessionId, currentSessionId, view, branches };
  }

  async fork(
    tenantId: string,
    sourceSessionId: string,
    idempotencyKey: string,
    request: CreateConversationForkRequest,
  ): Promise<ConversationForkResource> {
    const requestSha256 = sha256(request);
    try {
      return await this.#database.transaction().execute(async (transaction) => {
        const replay = await transaction
          .selectFrom("conversation_fork_operations as operation")
          .innerJoin("sessions as child", (join) =>
            join
              .onRef("child.tenant_id", "=", "operation.tenant_id")
              .onRef("child.id", "=", "operation.child_session_id"),
          )
          .select([
            "operation.request_sha256 as requestSha256",
            "operation.source_turn_id as sourceTurnId",
            "operation.source_entry_id as sourceEntryId",
            "child.id",
            "child.title",
            "child.project_id as projectId",
            "child.workspace_id as workspaceId",
            "child.sandbox_retention_policy as sandboxRetention",
            "child.desired_model_profile_id as modelProfileId",
            "child.created_at as createdAt",
          ])
          .where("operation.tenant_id", "=", tenantId)
          .where("operation.source_session_id", "=", sourceSessionId)
          .where("operation.idempotency_key", "=", idempotencyKey)
          .executeTakeFirst();
        if (replay !== undefined) {
          if (replay.requestSha256 !== requestSha256) {
            throw new ControlPlaneStoreError(
              "idempotency_conflict",
              "Idempotency key was already used for a different fork",
            );
          }
          return {
            session: {
              sessionId: replay.id,
              title: replay.title,
              projectId: replay.projectId,
              workspaceId: replay.workspaceId,
              state: "cold",
              sandboxRetention: replay.sandboxRetention,
              modelProfileId: replay.modelProfileId,
              createdAt: new Date(replay.createdAt).toISOString(),
            },
            parentSessionId: sourceSessionId,
            forkedFromTurnId: replay.sourceTurnId,
            forkedFromEntryId: replay.sourceEntryId,
            replayed: true,
          };
        }

        const source = await transaction
          .selectFrom("sessions")
          .select([
            "id",
            "title",
            "project_id",
            "workspace_id",
            "desired_model_profile_id",
            "state",
            "sandbox_retention_policy",
            "workspace_snapshot_key",
            "current_workspace_version_id",
            "conversation_fork_entry_id",
            "archived_at",
          ])
          .where("tenant_id", "=", tenantId)
          .where("id", "=", sourceSessionId)
          .forUpdate()
          .executeTakeFirst();
        if (source === undefined || source.archived_at !== null) {
          throw new ControlPlaneStoreError("not_found", "Conversation was not found");
        }
        if (!(["cold", "idle", "failed"] as const).some((state) => state === source.state)) {
          throw new ControlPlaneStoreError(
            "conflict",
            "Wait for the current conversation run to settle before forking",
          );
        }
        const unsettled = await transaction
          .selectFrom("turns")
          .select("id")
          .where("tenant_id", "=", tenantId)
          .where("session_id", "=", sourceSessionId)
          .where("state", "in", [
            "queued",
            "dispatching",
            "running",
            "waiting_approval",
            "cancelling",
          ])
          .executeTakeFirst();
        if (unsettled !== undefined) {
          throw new ControlPlaneStoreError(
            "conflict",
            "Wait for the current conversation run to settle before forking",
          );
        }
        const policy = await transaction
          .selectFrom("tenant_runtime_policies")
          .select("maximum_sessions")
          .where("tenant_id", "=", tenantId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const sessionCount = await transaction
          .selectFrom("sessions")
          .select((expression) => expression.fn.countAll<string>().as("count"))
          .where("tenant_id", "=", tenantId)
          .executeTakeFirstOrThrow();
        if (safeInteger(sessionCount.count, "Tenant Session count") >= policy.maximum_sessions) {
          throw new ControlPlaneStoreError(
            "tenant_quota_exceeded",
            "Tenant session quota has been reached",
          );
        }

        const leaf = await transaction
          .selectFrom("pi_session_lanes")
          .select("leaf_id")
          .where("tenant_id", "=", tenantId)
          .where("session_id", "=", sourceSessionId)
          .where("lane", "=", "main")
          .executeTakeFirst();
        if (leaf?.leaf_id === null || leaf === undefined) {
          throw new ControlPlaneStoreError("conflict", "Conversation has no forkable Pi history");
        }
        const [entriesBySession, turnsBySession] = await Promise.all([
          sessionEntries(transaction, tenantId, [sourceSessionId]),
          completedTurns(transaction, tenantId, [sourceSessionId]),
        ]);
        const sourceBranch = activeBranch(
          entriesBySession.get(sourceSessionId) ?? [],
          leaf.leaf_id,
        );
        const sourceOwnBranch = ownBranch(sourceBranch, source.conversation_fork_entry_id);
        const mapped = mappedConversationEntries(
          sourceOwnBranch,
          turnsBySession.get(sourceSessionId) ?? [],
        );
        const target = mapped.find(
          (entry) =>
            entry.finalAssistant &&
            entry.turnId === request.turnId &&
            entry.entryId === request.entryId,
        );
        if (target === undefined) {
          throw new ControlPlaneStoreError(
            "invalid_request",
            "Fork target is not a completed final assistant response",
          );
        }
        const targetIndex = sourceBranch.findIndex((entry) => entry.id === request.entryId);
        if (targetIndex < 0) {
          throw new ControlPlaneStoreError(
            "invalid_request",
            "Fork entry is not on the main branch",
          );
        }
        const copiedBranch = sourceBranch.slice(0, targetIndex + 1);
        const childSessionId = this.#idGenerator();
        const title = request.title ?? `${source.title} · 分支`;
        const createdAt = new Date();
        const maximumSequence = copiedBranch.reduce(
          (maximum, entry) => Math.max(maximum, safeInteger(entry.seq, "Pi entry sequence")),
          0,
        );

        const child = await transaction
          .insertInto("sessions")
          .values({
            id: childSessionId,
            title,
            tenant_id: tenantId,
            project_id: source.project_id,
            workspace_id: source.workspace_id,
            desired_model_profile_id: source.desired_model_profile_id,
            state: "cold",
            sandbox_retention_policy: source.sandbox_retention_policy,
            pi_session_snapshot_key: null,
            workspace_snapshot_key: source.workspace_snapshot_key,
            current_workspace_version_id: source.current_workspace_version_id,
            conversation_parent_session_id: sourceSessionId,
            conversation_fork_turn_id: request.turnId,
            conversation_fork_entry_id: request.entryId,
          })
          .returning(["id", "title", "created_at"])
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("session_event_cursors")
          .values({ session_id: childSessionId })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("pi_sessions")
          .values({
            tenant_id: tenantId,
            id: childSessionId,
            created_at_ms: createdAt.valueOf(),
            parent_session_id: sourceSessionId,
            next_seq: maximumSequence + 1,
            name: title,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("pi_session_lanes")
          .values({
            tenant_id: tenantId,
            session_id: childSessionId,
            lane: "main",
            leaf_id: request.entryId,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("pi_session_entries")
          .values(
            copiedBranch.map((entry) => ({
              tenant_id: tenantId,
              session_id: childSessionId,
              id: entry.id,
              seq: entry.seq,
              parent_id: entry.parentId,
              type: entry.type,
              custom_type: entry.customType,
              timestamp_ms: entry.timestampMs,
              payload: entry.payload,
            })),
          )
          .execute();
        await transaction
          .insertInto("pi_session_log")
          .values(
            copiedBranch.map((entry) => ({
              tenant_id: tenantId,
              session_id: childSessionId,
              seq: entry.seq,
              kind: "entry",
              payload: { entry: entry.payload },
            })),
          )
          .execute();
        const copiedEntryIds = copiedBranch.map((entry) => entry.id);
        const labels = await transaction
          .selectFrom("pi_session_labels")
          .select(["target_id", "label", "updated_seq"])
          .where("tenant_id", "=", tenantId)
          .where("session_id", "=", sourceSessionId)
          .where("target_id", "in", copiedEntryIds)
          .execute();
        if (labels.length > 0) {
          await transaction
            .insertInto("pi_session_labels")
            .values(
              labels.map((label) => ({
                tenant_id: tenantId,
                session_id: childSessionId,
                target_id: label.target_id,
                label: label.label,
                updated_seq: label.updated_seq,
              })),
            )
            .execute();
        }
        await transaction
          .insertInto("conversation_fork_operations")
          .values({
            tenant_id: tenantId,
            source_session_id: sourceSessionId,
            idempotency_key: idempotencyKey,
            request_sha256: requestSha256,
            source_turn_id: request.turnId,
            source_entry_id: request.entryId,
            child_session_id: childSessionId,
          })
          .executeTakeFirstOrThrow();
        return {
          session: {
            sessionId: child.id,
            title: child.title,
            projectId: source.project_id,
            workspaceId: source.workspace_id,
            state: "cold",
            sandboxRetention: source.sandbox_retention_policy,
            modelProfileId: source.desired_model_profile_id,
            createdAt: new Date(child.created_at).toISOString(),
          },
          parentSessionId: sourceSessionId,
          forkedFromTurnId: request.turnId,
          forkedFromEntryId: request.entryId,
          replayed: false,
        };
      });
    } catch (error: unknown) {
      if (error instanceof ControlPlaneStoreError) throw error;
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505" &&
        "constraint" in error &&
        error.constraint === "conversation_fork_operations_pkey"
      ) {
        return this.fork(tenantId, sourceSessionId, idempotencyKey, request);
      }
      throw error;
    }
  }

  async #lineage(tenantId: string, sessionId: string): Promise<SessionRow[]> {
    const result: SessionRow[] = [];
    const seen = new Set<string>();
    let cursor: string | null = sessionId;
    while (cursor !== null) {
      if (seen.has(cursor) || result.length >= MAX_TREE_BRANCHES) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Conversation lineage is invalid or too deep",
        );
      }
      seen.add(cursor);
      const row = await this.#database
        .selectFrom("sessions")
        .select([
          "id",
          "title",
          "conversation_parent_session_id as parentSessionId",
          "conversation_fork_turn_id as forkTurnId",
          "conversation_fork_entry_id as forkEntryId",
        ])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", cursor)
        .where("archived_at", "is", null)
        .executeTakeFirst();
      if (row === undefined) {
        throw new ControlPlaneStoreError("not_found", "Conversation was not found");
      }
      result.push(row);
      cursor = row.parentSessionId;
    }
    return result.reverse();
  }

  async #family(tenantId: string, rootSessionId: string): Promise<SessionRow[]> {
    const family = await sql<{
      id: string;
      title: string;
      parent_session_id: string | null;
      fork_turn_id: string | null;
      fork_entry_id: string | null;
      depth: number;
    }>`
      with recursive family as (
        select id,
               title,
               conversation_parent_session_id as parent_session_id,
               conversation_fork_turn_id as fork_turn_id,
               conversation_fork_entry_id as fork_entry_id,
               created_at,
               0 as depth
          from sessions
         where tenant_id = ${tenantId}::uuid
           and id = ${rootSessionId}::uuid
           and archived_at is null
        union all
        select child.id,
               child.title,
               child.conversation_parent_session_id,
               child.conversation_fork_turn_id,
               child.conversation_fork_entry_id,
               child.created_at,
               family.depth + 1
          from sessions child
          join family on child.conversation_parent_session_id = family.id
         where child.tenant_id = ${tenantId}::uuid
           and child.archived_at is null
           and family.depth < ${MAX_TREE_BRANCHES}
      )
      select id, title, parent_session_id, fork_turn_id, fork_entry_id, depth
        from family
       order by depth, created_at, id
       limit ${MAX_TREE_BRANCHES + 1}
    `.execute(this.#database);
    if (family.rows.length > MAX_TREE_BRANCHES) {
      throw new ControlPlaneStoreError(
        "invalid_request",
        "Conversation tree has too many branches",
      );
    }
    return family.rows.map((row) => ({
      id: row.id,
      title: row.title,
      parentSessionId: row.parent_session_id,
      forkTurnId: row.fork_turn_id,
      forkEntryId: row.fork_entry_id,
    }));
  }
}
