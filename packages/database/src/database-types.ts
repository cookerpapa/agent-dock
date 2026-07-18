import type {
  AgentNodeState,
  ApprovalState,
  ModelThinkingLevel,
  SandboxState,
  SessionState,
  TurnState,
} from "@agent-dock/domain";
import type { ColumnType, JSONColumnType } from "kysely";

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type Int8 = ColumnType<string, bigint | number | string, bigint | number | string>;
type GeneratedInt8 = ColumnType<
  string,
  bigint | number | string | undefined,
  bigint | number | string
>;
type GeneratedBoolean = ColumnType<boolean, boolean | undefined, boolean>;
type GeneratedInteger = ColumnType<number, number | undefined, number>;
type JsonObject = JSONColumnType<
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>
>;

export type CredentialBindingStatus = "active" | "disabled" | "revoked";
export type CredentialKind = "oauth" | "api_key" | "brokered";
export type TurnInputKind = "prompt" | "continue";
export type CommandKind = "turn.execute" | "turn.cancel" | "approval.resolve";
export type CommandState = "pending" | "dispatched" | "acknowledged" | "completed" | "failed";
export type ApprovalKind = "confirm" | "select" | "input" | "editor";
export type ApprovalOutcome = "approved" | "rejected" | "cancelled";
export type ArtifactKind =
  | "pi_session_snapshot"
  | "workspace_snapshot"
  | "tool_output"
  | "patch"
  | "report"
  | "crash_bundle";

export interface TenantTable {
  id: string;
  slug: string;
  created_at: GeneratedTimestamp;
}

export interface UserTable {
  id: string;
  tenant_id: string;
  display_name: string;
  created_at: GeneratedTimestamp;
}

export interface ProjectTable {
  id: string;
  tenant_id: string;
  name: string;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface WorkspaceTable {
  id: string;
  tenant_id: string;
  project_id: string;
  object_snapshot_key: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface CredentialBindingTable {
  id: string;
  tenant_id: string;
  provider: string;
  kind: CredentialKind;
  secret_ref: string;
  version: GeneratedInt8;
  status: CredentialBindingStatus;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ModelProfileTable {
  id: string;
  tenant_id: string;
  name: string;
  provider: string;
  model_id: string;
  default_thinking_level: ModelThinkingLevel;
  allowed_thinking_levels: ModelThinkingLevel[];
  credential_binding_id: string;
  credential_binding_version: Int8;
  enabled: GeneratedBoolean;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface SessionTable {
  id: string;
  tenant_id: string;
  project_id: string;
  workspace_id: string;
  desired_model_profile_id: string;
  state: SessionState;
  pi_session_snapshot_key: string | null;
  workspace_snapshot_key: string | null;
  next_event_seq: GeneratedInt8;
  last_fencing_token: GeneratedInt8;
  row_version: GeneratedInt8;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  last_active_at: GeneratedTimestamp;
}

export interface TurnTable {
  id: string;
  tenant_id: string;
  session_id: string;
  state: TurnState;
  input_kind: TurnInputKind;
  input_text: string | null;
  model_profile_id: string;
  provider: string;
  model_id: string;
  thinking_level: ModelThinkingLevel;
  credential_binding_id: string;
  credential_binding_version: Int8;
  stop_reason: string | null;
  failure_code: string | null;
  failure_message: string | null;
  failure_retryable: boolean | null;
  created_at: GeneratedTimestamp;
  started_at: NullableTimestamp;
  settled_at: NullableTimestamp;
}

export interface AgentNodeTable {
  id: string;
  tenant_id: string;
  session_id: string;
  parent_agent_node_id: string | null;
  state: AgentNodeState;
  depth: number;
  model_profile_id: string;
  provider: string;
  model_id: string;
  thinking_level: ModelThinkingLevel;
  credential_binding_id: string;
  credential_binding_version: Int8;
  token_budget: Int8 | null;
  wall_time_budget_ms: Int8 | null;
  created_at: GeneratedTimestamp;
  started_at: NullableTimestamp;
  settled_at: NullableTimestamp;
}

export interface SandboxTable {
  id: string;
  supervisor_id: string;
  boot_id: string;
  state: SandboxState;
  max_concurrent_sessions: number;
  active_sessions: GeneratedInteger;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  terminated_at: NullableTimestamp;
}

export interface SessionLeaseTable {
  session_id: string;
  lease_id: string;
  sandbox_id: string;
  fencing_token: Int8;
  valid_until: Timestamp;
  acquired_at: GeneratedTimestamp;
  renewed_at: GeneratedTimestamp;
}

export interface CommandTable {
  id: string;
  tenant_id: string;
  session_id: string;
  turn_id: string;
  idempotency_key: string;
  kind: CommandKind;
  state: CommandState;
  payload: JsonObject;
  created_at: GeneratedTimestamp;
  dispatched_at: NullableTimestamp;
  acknowledged_at: NullableTimestamp;
  completed_at: NullableTimestamp;
  failure_code: string | null;
}

export interface ApprovalTable {
  id: string;
  tenant_id: string;
  session_id: string;
  turn_id: string;
  kind: ApprovalKind;
  state: ApprovalState;
  request_payload: JsonObject;
  outcome: ApprovalOutcome | null;
  resolved_value: string | null;
  requested_at: GeneratedTimestamp;
  expires_at: NullableTimestamp;
  resolved_at: NullableTimestamp;
}

export interface SessionEventTable {
  event_id: string;
  tenant_id: string;
  session_id: string;
  turn_id: string | null;
  agent_node_id: string | null;
  seq: Int8;
  schema_version: number;
  type: string;
  payload: JsonObject;
  lease_id: string;
  fencing_token: Int8;
  occurred_at: Timestamp;
  persisted_at: GeneratedTimestamp;
}

export interface SessionEventCursorTable {
  session_id: string;
  last_persisted_seq: GeneratedInt8;
  acknowledged_through_seq: GeneratedInt8;
  updated_at: GeneratedTimestamp;
}

export interface OutboxTable {
  id: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  topic: string;
  payload: JsonObject;
  attempts: GeneratedInteger;
  available_at: GeneratedTimestamp;
  created_at: GeneratedTimestamp;
  published_at: NullableTimestamp;
  last_error: string | null;
}

export interface ArtifactTable {
  id: string;
  tenant_id: string;
  session_id: string;
  turn_id: string | null;
  kind: ArtifactKind;
  object_key: string;
  sha256: string;
  size_bytes: Int8;
  created_at: GeneratedTimestamp;
}

export interface UsageLedgerTable {
  id: string;
  tenant_id: string;
  session_id: string;
  turn_id: string;
  provider: string;
  model_id: string;
  input_tokens: Int8;
  output_tokens: Int8;
  cache_read_tokens: Int8;
  cache_write_tokens: Int8;
  cost_amount: ColumnType<string, number | string, number | string>;
  created_at: GeneratedTimestamp;
}

export interface Database {
  tenants: TenantTable;
  users: UserTable;
  projects: ProjectTable;
  workspaces: WorkspaceTable;
  credential_bindings: CredentialBindingTable;
  model_profiles: ModelProfileTable;
  sessions: SessionTable;
  turns: TurnTable;
  agent_nodes: AgentNodeTable;
  sandboxes: SandboxTable;
  session_leases: SessionLeaseTable;
  commands: CommandTable;
  approvals: ApprovalTable;
  session_events: SessionEventTable;
  session_event_cursors: SessionEventCursorTable;
  outbox: OutboxTable;
  artifacts: ArtifactTable;
  usage_ledger: UsageLedgerTable;
}
