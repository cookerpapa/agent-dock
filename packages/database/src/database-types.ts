import type {
  AgentNodeState,
  ApprovalState,
  CommandState as DomainCommandState,
  ModelThinkingLevel,
  RunAttemptState,
  RunState,
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
type GeneratedNullable<Value> = ColumnType<Value | null, Value | null | undefined, Value | null>;
type Int8 = ColumnType<string, bigint | number | string, bigint | number | string>;
type GeneratedInt8 = ColumnType<
  string,
  bigint | number | string | undefined,
  bigint | number | string
>;
type NullableInt8 = ColumnType<
  string | null,
  bigint | number | string | null | undefined,
  bigint | number | string | null
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
export type CommandState = DomainCommandState;
export type ApprovalKind = "confirm" | "select" | "input" | "editor";
export type ApprovalOutcome = "approved" | "rejected" | "cancelled";
export type ArtifactKind =
  | "pi_session_snapshot"
  | "workspace_snapshot"
  | "tool_output"
  | "patch"
  | "report"
  | "crash_bundle";
export type SupervisorConnectionState = "active" | "superseded" | "fenced";
export type SupervisorConnectionCloseReason = "reconnected" | "heartbeat_timeout" | "new_boot";
export type SandboxRetirementReason = "heartbeat_timeout" | "new_boot";
export type SandboxRetirementState = "pending" | "claimed" | "blocked" | "completed";
export type TenantApiCredentialRole = "owner" | "member" | "viewer";
export type WorkspaceSourceKind = "sample_java" | "github_public" | "github_app";
export type WorkspaceImportStatus = "pending" | "importing" | "ready" | "failed";
export type WorkspaceVersionOrigin = "checkpoint" | "fork" | "migration";
export type WorkspaceOperationKind = "fork" | "rollback" | "archive" | "unarchive";
export type GitHubInstallationStatus = "active" | "suspended" | "removed";
export type GitHubPullRequestDeliveryState = "pending" | "delivering" | "completed" | "failed";
export type GitHubWebhookDeliveryStatus = "processed" | "ignored" | "failed";
export type ModelRequestState = "reserved" | "completed" | "failed" | "aborted" | "budget_denied";
export type ContextCompactionState = "running" | "completed" | "aborted" | "failed";

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

export interface TenantRuntimePolicyTable {
  tenant_id: string;
  default_model_profile_id: string;
  enabled: GeneratedBoolean;
  maximum_projects: GeneratedInteger;
  maximum_sessions: GeneratedInteger;
  maximum_unsettled_turns: GeneratedInteger;
  maximum_concurrent_turns: GeneratedInteger;
  maximum_model_requests_per_run: GeneratedInteger;
  maximum_tokens_per_run: GeneratedInt8;
  maximum_cost_microusd_per_run: GeneratedInt8;
  daily_token_budget: GeneratedInt8;
  monthly_cost_microusd_budget: GeneratedInt8;
  maximum_tool_calls_per_run: GeneratedInteger;
  maximum_tool_output_bytes: GeneratedInteger;
  maximum_run_duration_ms: GeneratedInteger;
  compaction_reserve_tokens: GeneratedInteger;
  compaction_keep_recent_tokens: GeneratedInteger;
  last_scheduled_at: GeneratedTimestamp;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface TenantApiCredentialTable {
  credential_id: string;
  tenant_id: string;
  user_id: string;
  label: string;
  role: TenantApiCredentialRole;
  secret_sha256: string;
  created_at: GeneratedTimestamp;
  expires_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  last_used_at: NullableTimestamp;
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

export interface WorkspaceSourceTable {
  tenant_id: string;
  workspace_id: string;
  kind: WorkspaceSourceKind;
  repository: string | null;
  commit_sha: string | null;
  status: WorkspaceImportStatus;
  object_key: string | null;
  sha256: string | null;
  size_bytes: NullableInt8;
  import_lease_id: string | null;
  lease_expires_at: NullableTimestamp;
  failure_code: string | null;
  github_installation_id: NullableInt8;
  github_repository_id: NullableInt8;
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

export interface TenantModelCredentialTable {
  tenant_id: string;
  credential_binding_id: string;
  credential_binding_version: Int8;
  key_version: number;
  nonce: string;
  ciphertext: string;
  auth_tag: string;
  secret_sha256: string;
  created_at: GeneratedTimestamp;
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
  next_mailbox_position: GeneratedInt8;
  last_fencing_token: GeneratedInt8;
  row_version: GeneratedInt8;
  current_workspace_version_id: GeneratedNullable<string>;
  forked_from_session_id: GeneratedNullable<string>;
  archived_at: NullableTimestamp;
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

export interface RunTable {
  id: string;
  tenant_id: string;
  project_id: string;
  workspace_id: string;
  session_id: string;
  turn_id: string;
  command_id: string;
  idempotency_key: string;
  state: RunState;
  current_attempt_id: string | null;
  attempt_count: GeneratedInteger;
  stop_reason: string | null;
  failure_code: string | null;
  failure_message: string | null;
  failure_retryable: boolean | null;
  row_version: GeneratedInt8;
  queued_at: GeneratedTimestamp;
  started_at: NullableTimestamp;
  settled_at: NullableTimestamp;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface RunAttemptTable {
  id: string;
  tenant_id: string;
  run_id: string;
  attempt_number: number;
  state: RunAttemptState;
  claim_owner_id: string;
  claim_expires_at: Timestamp;
  sandbox_id: string | null;
  lease_id: string | null;
  fencing_token: NullableInt8;
  checkpoint_revision: string | null;
  failure_code: string | null;
  failure_message: string | null;
  failure_retryable: boolean | null;
  claimed_at: GeneratedTimestamp;
  provisioning_at: NullableTimestamp;
  restoring_at: NullableTimestamp;
  running_at: NullableTimestamp;
  checkpointing_at: NullableTimestamp;
  last_heartbeat_at: NullableTimestamp;
  settled_at: NullableTimestamp;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface RunAttemptTransitionTable {
  id: string;
  tenant_id: string;
  run_id: string;
  attempt_id: string;
  from_state: RunAttemptState | null;
  to_state: RunAttemptState;
  reason: string;
  occurred_at: GeneratedTimestamp;
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

export interface SupervisorConnectionTable {
  connection_id: string;
  transport_id: string;
  registration_message_id: string;
  registered_message_id: string;
  sandbox_id: string;
  supervisor_id: string;
  boot_id: string;
  control_plane_instance_id: string;
  state: SupervisorConnectionState;
  close_reason: SupervisorConnectionCloseReason | null;
  registration_fingerprint: string;
  supervisor_version: string;
  pi_package_name: string;
  pi_version: string;
  supported_protocol_versions: number[];
  capabilities: string[];
  selected_protocol_version: number;
  heartbeat_interval_ms: number;
  heartbeat_timeout_ms: number;
  accepting_assignments: GeneratedBoolean;
  registered_at: Timestamp;
  last_heartbeat_at: Timestamp;
  expires_at: Timestamp;
  closed_at: NullableTimestamp;
}

export interface SupervisorBootCredentialTable {
  credential_id: string;
  credential_sha256: string;
  provision_request_id: string;
  sandbox_id: string;
  supervisor_id: string;
  boot_id: string;
  created_at: Timestamp;
  expires_at: Timestamp;
  revoked_at: NullableTimestamp;
}

export interface SupervisorHostTable {
  supervisor_id: string;
  maximum_capacity: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SandboxRetirementTable {
  sandbox_id: string;
  supervisor_id: string;
  boot_id: string;
  reason: SandboxRetirementReason;
  state: SandboxRetirementState;
  attempts: GeneratedInteger;
  available_at: GeneratedTimestamp;
  claim_id: string | null;
  claim_owner_id: string | null;
  claim_until: NullableTimestamp;
  last_error: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  completed_at: NullableTimestamp;
}

export interface CommandTable {
  id: string;
  tenant_id: string;
  session_id: string;
  turn_id: string;
  idempotency_key: string;
  kind: CommandKind;
  state: CommandState;
  mailbox_position: NullableInt8;
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
  agent_id: string;
  command_id: string | null;
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
  run_id: GeneratedNullable<string>;
  file_name: GeneratedNullable<string>;
  media_type: GeneratedNullable<string>;
  object_key: string;
  sha256: string;
  size_bytes: Int8;
  created_at: GeneratedTimestamp;
}

export interface WorkspaceVersionTable {
  id: string;
  tenant_id: string;
  workspace_id: string;
  session_id: string;
  version_number: number;
  parent_version_id: string | null;
  source_version_id: string | null;
  origin_kind: WorkspaceVersionOrigin;
  run_id: string | null;
  attempt_id: string | null;
  turn_id: string | null;
  pi_artifact_id: string;
  workspace_artifact_id: string;
  patch_artifact_id: string | null;
  revision: string;
  file_count: GeneratedInteger;
  state: "staged" | "settled" | "abandoned";
  created_at: GeneratedTimestamp;
  settled_at: NullableTimestamp;
}

export interface WorkspaceOperationTable {
  id: string;
  tenant_id: string;
  session_id: string;
  kind: WorkspaceOperationKind;
  idempotency_key: string;
  from_version_id: string | null;
  to_version_id: string | null;
  source_session_id: string | null;
  created_at: GeneratedTimestamp;
}

export interface TestResultTable {
  id: string;
  tenant_id: string;
  session_id: string;
  turn_id: string;
  run_id: string;
  workspace_version_id: string | null;
  tool_call_id: string;
  command: string;
  suite: string;
  status: "passed" | "failed" | "errored";
  exit_code: number | null;
  duration_ms: number | null;
  summary: string | null;
  artifact_id: string | null;
  created_at: GeneratedTimestamp;
}

export interface GitHubAppInstallationTable {
  tenant_id: string;
  installation_id: Int8;
  account_id: Int8;
  account_login: string;
  target_type: "User" | "Organization";
  repository_selection: "all" | "selected";
  status: GitHubInstallationStatus;
  permissions: JsonObject;
  suspended_at: NullableTimestamp;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface GitHubRepositoryTable {
  tenant_id: string;
  repository_id: Int8;
  installation_id: Int8;
  full_name: string;
  owner_login: string;
  name: string;
  private: boolean;
  default_branch: string;
  enabled: GeneratedBoolean;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface GitHubPullRequestDeliveryTable {
  id: string;
  tenant_id: string;
  workspace_version_id: string;
  repository_id: Int8;
  installation_id: Int8;
  idempotency_key: string;
  state: GitHubPullRequestDeliveryState;
  base_branch: string;
  base_commit_sha: string;
  head_branch: string;
  title: string;
  body: string;
  commit_sha: string | null;
  pull_request_number: number | null;
  pull_request_url: string | null;
  check_run_id: NullableInt8;
  attempts: GeneratedInteger;
  failure_code: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  completed_at: NullableTimestamp;
}

export interface GitHubWebhookDeliveryTable {
  delivery_id: string;
  event_name: string;
  payload_sha256: string;
  tenant_id: string | null;
  installation_id: NullableInt8;
  status: GitHubWebhookDeliveryStatus;
  failure_code: string | null;
  received_at: GeneratedTimestamp;
  processed_at: NullableTimestamp;
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
  run_id: GeneratedNullable<string>;
  attempt_id: GeneratedNullable<string>;
  model_request_id: GeneratedNullable<string>;
  model_profile_id: GeneratedNullable<string>;
  cost_microusd: NullableInt8;
  created_at: GeneratedTimestamp;
}

export interface ModelRateTable {
  tenant_id: string;
  provider: string;
  model_id: string;
  input_microusd_per_million: GeneratedInt8;
  output_microusd_per_million: GeneratedInt8;
  cache_read_microusd_per_million: GeneratedInt8;
  cache_write_microusd_per_million: GeneratedInt8;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ModelRoutingPolicyTable {
  tenant_id: string;
  model_profile_id: string;
  fallback_provider: string | null;
  fallback_model_id: string | null;
  fallback_on_rate_limit: GeneratedBoolean;
  fallback_on_server_error: GeneratedBoolean;
  fallback_on_timeout: GeneratedBoolean;
  enabled: GeneratedBoolean;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ModelRequestTable {
  id: string;
  tenant_id: string;
  session_id: string;
  turn_id: string;
  run_id: string;
  attempt_id: string;
  model_profile_id: string;
  request_sequence: number;
  requested_provider: string;
  requested_model_id: string;
  actual_provider: string | null;
  actual_model_id: string | null;
  state: ModelRequestState;
  fallback_reason: string | null;
  reserved_input_tokens: Int8;
  reserved_output_tokens: Int8;
  reserved_cost_microusd: Int8;
  actual_input_tokens: NullableInt8;
  actual_output_tokens: NullableInt8;
  actual_cache_read_tokens: NullableInt8;
  actual_cache_write_tokens: NullableInt8;
  actual_input_microusd_per_million: NullableInt8;
  actual_output_microusd_per_million: NullableInt8;
  actual_cache_read_microusd_per_million: NullableInt8;
  actual_cache_write_microusd_per_million: NullableInt8;
  actual_cost_microusd: NullableInt8;
  upstream_status: number | null;
  failure_code: string | null;
  reservation_expires_at: Timestamp;
  started_at: GeneratedTimestamp;
  settled_at: NullableTimestamp;
}

export interface ContextCompactionTable {
  id: string;
  tenant_id: string;
  session_id: string;
  turn_id: string;
  run_id: string;
  attempt_id: string;
  started_event_id: string;
  completed_event_id: string | null;
  reason: "manual" | "threshold" | "overflow";
  state: ContextCompactionState;
  tokens_before: NullableInt8;
  estimated_tokens_after: NullableInt8;
  first_kept_entry_id: string | null;
  summary_sha256: string | null;
  summary_version: number | null;
  will_retry: GeneratedBoolean;
  started_at: Timestamp;
  completed_at: NullableTimestamp;
}

export interface Database {
  tenants: TenantTable;
  users: UserTable;
  tenant_runtime_policies: TenantRuntimePolicyTable;
  tenant_api_credentials: TenantApiCredentialTable;
  projects: ProjectTable;
  workspaces: WorkspaceTable;
  workspace_sources: WorkspaceSourceTable;
  workspace_versions: WorkspaceVersionTable;
  workspace_operations: WorkspaceOperationTable;
  credential_bindings: CredentialBindingTable;
  model_profiles: ModelProfileTable;
  tenant_model_credentials: TenantModelCredentialTable;
  sessions: SessionTable;
  turns: TurnTable;
  runs: RunTable;
  run_attempts: RunAttemptTable;
  run_attempt_transitions: RunAttemptTransitionTable;
  agent_nodes: AgentNodeTable;
  sandboxes: SandboxTable;
  supervisor_connections: SupervisorConnectionTable;
  supervisor_boot_credentials: SupervisorBootCredentialTable;
  supervisor_hosts: SupervisorHostTable;
  sandbox_retirements: SandboxRetirementTable;
  session_leases: SessionLeaseTable;
  commands: CommandTable;
  approvals: ApprovalTable;
  session_events: SessionEventTable;
  session_event_cursors: SessionEventCursorTable;
  outbox: OutboxTable;
  artifacts: ArtifactTable;
  test_results: TestResultTable;
  usage_ledger: UsageLedgerTable;
  model_rates: ModelRateTable;
  model_routing_policies: ModelRoutingPolicyTable;
  model_requests: ModelRequestTable;
  context_compactions: ContextCompactionTable;
  github_app_installations: GitHubAppInstallationTable;
  github_repositories: GitHubRepositoryTable;
  github_pull_request_deliveries: GitHubPullRequestDeliveryTable;
  github_webhook_deliveries: GitHubWebhookDeliveryTable;
}
