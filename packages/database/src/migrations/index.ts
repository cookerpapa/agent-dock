import type { MigrationProvider } from "kysely/migration";
import * as initialControlPlane from "./001_initial_control_plane.ts";
import * as durableEventDelivery from "./002_durable_event_delivery.ts";
import * as explicitSessionMailbox from "./003_explicit_session_mailbox.ts";
import * as supervisorConnectionHealth from "./004_supervisor_connection_health.ts";
import * as supervisorBootCredentials from "./005_supervisor_boot_credentials.ts";
import * as privateMultiTenantIdentity from "./006_private_multi_tenant_identity.ts";
import * as encryptedTenantModelCredentials from "./007_encrypted_tenant_model_credentials.ts";
import * as controlledWorkspaceSources from "./008_controlled_workspace_sources.ts";
import * as durableRunsAndAttempts from "./009_durable_runs_and_attempts.ts";
import * as versionedWorkspacesAndGitHubDelivery from "./010_versioned_workspaces_and_github_delivery.ts";
import * as contextAndModelGovernance from "./011_context_and_model_governance.ts";
import * as observabilityTraceIdentity from "./012_observability_trace_identity.ts";
import * as productAuthAndEmptyWorkspaces from "./013_product_auth_and_empty_workspaces.ts";
import * as removePerRunTokenBudget from "./014_remove_per_run_token_budget.ts";
import * as versionedProjectEnvironments from "./015_versioned_project_environments.ts";
import * as environmentRecipesAndOperations from "./016_environment_recipes_and_operations.ts";
import * as multiRepositorySourceSets from "./017_multi_repository_source_sets.ts";
import * as attemptRewindsAndReviewBundles from "./018_attempt_rewinds_and_review_bundles.ts";
import * as legacyEnvironmentValidationEvidence from "./019_legacy_environment_validation_evidence.ts";
import * as semanticConversationProjections from "./020_semantic_conversation_projections.ts";
import * as parallelCandidateRaces from "./021_parallel_candidate_races.ts";
import * as horizontalSupervisorPool from "./022_horizontal_supervisor_pool.ts";
import * as temporalWorkerAffinity from "./023_temporal_worker_affinity.ts";
import * as hotPlatformRuntimeSettings from "./024_hot_platform_runtime_settings.ts";
import * as largeWorkspaceCheckpoints from "./025_large_workspace_checkpoints.ts";
import * as workspaceFirstConversations from "./026_workspace_first_conversations.ts";
import * as sharedWorkspaceHeads from "./027_shared_workspace_heads.ts";
import * as interruptedPiConversations from "./028_interrupted_pi_conversations.ts";
import * as externalPlatformGitMetadata from "./029_external_platform_git_metadata.ts";
import * as activePiSteer from "./030_active_pi_steer.ts";
import * as typedToolOutcomes from "./031_typed_tool_outcomes.ts";
import * as modelSamplingStepIdentity from "./032_model_sampling_step_identity.ts";
import * as enterpriseExecutionCells from "./033_enterprise_execution_cells.ts";
import * as sandboxManagerOwnership from "./034_sandbox_manager_ownership.ts";
import * as partitionedSessionEventLog from "./035_partitioned_session_event_log.ts";
import * as fasterEventIdentityRegistration from "./036_faster_event_identity_registration.ts";
import * as executionCellWorkerRoutes from "./037_execution_cell_worker_routes.ts";
import * as workspaceCellMigrations from "./038_workspace_cell_migrations.ts";
import * as externalWorkerEventLog from "./039_external_worker_event_log.ts";
import * as sessionSandboxRetention from "./040_session_sandbox_retention.ts";
import * as decouplePersistentSandboxLeases from "./041_decouple_persistent_sandbox_leases.ts";
import * as kafkaFirstWorkerEventLog from "./042_kafka_first_worker_event_log.ts";
import * as sessionEventHotRetention from "./043_session_event_hot_retention.ts";
import * as canonicalConversationsAndLiveStreams from "./044_canonical_conversations_and_live_streams.ts";
import * as sandboxDomainsAndToolBroker from "./045_sandbox_domains_and_tool_broker.ts";
import * as temporalOutboxHandoff from "./046_temporal_outbox_handoff.ts";
import * as removeTemporalWorkerAffinity from "./047_remove_temporal_worker_affinity.ts";
import * as turnAdmissionIndex from "./048_turn_admission_index.ts";
import * as tenantSandboxQuota from "./049_tenant_sandbox_quota.ts";
import * as primaryToolBrokerRoute from "./050_primary_tool_broker_route.ts";
import * as bootstrapTenantSandboxQuota from "./051_bootstrap_tenant_sandbox_quota.ts";
import * as postgresRunQueue from "./052_postgres_run_queue.ts";
import * as piSessionStorage from "./053_pi_session_storage.ts";
import * as postgresCheckpointObjects from "./054_postgres_checkpoint_objects.ts";
import * as unlimitedDefaultDailyTokens from "./055_unlimited_default_daily_tokens.ts";
import * as codingRunModelRequestLimit from "./056_coding_run_model_request_limit.ts";
import * as conversationTreeForks from "./057_conversation_tree_forks.ts";
import * as workspaceDeletion from "./058_workspace_deletion.ts";
import * as piSessionOpaqueIdentifiers from "./059_pi_session_opaque_identifiers.ts";
import * as workspaceTerminalLeases from "./060_workspace_terminal_leases.ts";
import * as removeDormantAdvancedFeatures from "./061_remove_dormant_advanced_features.ts";
import * as postgresSessionStorageOnly from "./062_postgres_session_storage_only.ts";
import * as piCloudEnvironmentProfile from "./063_pi_cloud_environment_profile.ts";
import * as piCloudRunQueueNotification from "./064_pi_cloud_run_queue_notification.ts";
import * as runToolCapabilitySnapshots from "./065_run_tool_capability_snapshots.ts";

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return {
      "001_initial_control_plane": initialControlPlane,
      "002_durable_event_delivery": durableEventDelivery,
      "003_explicit_session_mailbox": explicitSessionMailbox,
      "004_supervisor_connection_health": supervisorConnectionHealth,
      "005_supervisor_boot_credentials": supervisorBootCredentials,
      "006_private_multi_tenant_identity": privateMultiTenantIdentity,
      "007_encrypted_tenant_model_credentials": encryptedTenantModelCredentials,
      "008_controlled_workspace_sources": controlledWorkspaceSources,
      "009_durable_runs_and_attempts": durableRunsAndAttempts,
      "010_versioned_workspaces_and_github_delivery": versionedWorkspacesAndGitHubDelivery,
      "011_context_and_model_governance": contextAndModelGovernance,
      "012_observability_trace_identity": observabilityTraceIdentity,
      "013_product_auth_and_empty_workspaces": productAuthAndEmptyWorkspaces,
      "014_remove_per_run_token_budget": removePerRunTokenBudget,
      "015_versioned_project_environments": versionedProjectEnvironments,
      "016_environment_recipes_and_operations": environmentRecipesAndOperations,
      "017_multi_repository_source_sets": multiRepositorySourceSets,
      "018_attempt_rewinds_and_review_bundles": attemptRewindsAndReviewBundles,
      "019_legacy_environment_validation_evidence": legacyEnvironmentValidationEvidence,
      "020_semantic_conversation_projections": semanticConversationProjections,
      "021_parallel_candidate_races": parallelCandidateRaces,
      "022_horizontal_supervisor_pool": horizontalSupervisorPool,
      "023_temporal_worker_affinity": temporalWorkerAffinity,
      "024_hot_platform_runtime_settings": hotPlatformRuntimeSettings,
      "025_large_workspace_checkpoints": largeWorkspaceCheckpoints,
      "026_workspace_first_conversations": workspaceFirstConversations,
      "027_shared_workspace_heads": sharedWorkspaceHeads,
      "028_interrupted_pi_conversations": interruptedPiConversations,
      "029_external_platform_git_metadata": externalPlatformGitMetadata,
      "030_active_pi_steer": activePiSteer,
      "031_typed_tool_outcomes": typedToolOutcomes,
      "032_model_sampling_step_identity": modelSamplingStepIdentity,
      "033_enterprise_execution_cells": enterpriseExecutionCells,
      "034_sandbox_manager_ownership": sandboxManagerOwnership,
      "035_partitioned_session_event_log": partitionedSessionEventLog,
      "036_faster_event_identity_registration": fasterEventIdentityRegistration,
      "037_execution_cell_worker_routes": executionCellWorkerRoutes,
      "038_workspace_cell_migrations": workspaceCellMigrations,
      "039_external_worker_event_log": externalWorkerEventLog,
      "040_session_sandbox_retention": sessionSandboxRetention,
      "041_decouple_persistent_sandbox_leases": decouplePersistentSandboxLeases,
      "042_kafka_first_worker_event_log": kafkaFirstWorkerEventLog,
      "043_session_event_hot_retention": sessionEventHotRetention,
      "044_canonical_conversations_and_live_streams": canonicalConversationsAndLiveStreams,
      "045_sandbox_domains_and_tool_broker": sandboxDomainsAndToolBroker,
      "046_temporal_outbox_handoff": temporalOutboxHandoff,
      "047_remove_temporal_worker_affinity": removeTemporalWorkerAffinity,
      "048_turn_admission_index": turnAdmissionIndex,
      "049_tenant_sandbox_quota": tenantSandboxQuota,
      "050_primary_tool_broker_route": primaryToolBrokerRoute,
      "051_bootstrap_tenant_sandbox_quota": bootstrapTenantSandboxQuota,
      "052_postgres_run_queue": postgresRunQueue,
      "053_pi_session_storage": piSessionStorage,
      "054_postgres_checkpoint_objects": postgresCheckpointObjects,
      "055_unlimited_default_daily_tokens": unlimitedDefaultDailyTokens,
      "056_coding_run_model_request_limit": codingRunModelRequestLimit,
      "057_conversation_tree_forks": conversationTreeForks,
      "058_workspace_deletion": workspaceDeletion,
      "059_pi_session_opaque_identifiers": piSessionOpaqueIdentifiers,
      "060_workspace_terminal_leases": workspaceTerminalLeases,
      "061_remove_dormant_advanced_features": removeDormantAdvancedFeatures,
      "062_postgres_session_storage_only": postgresSessionStorageOnly,
      "063_pi_cloud_environment_profile": piCloudEnvironmentProfile,
      "064_pi_cloud_run_queue_notification": piCloudRunQueueNotification,
      "065_run_tool_capability_snapshots": runToolCapabilitySnapshots,
    };
  },
};

export {
  down as downInitialControlPlane,
  up as upInitialControlPlane,
} from "./001_initial_control_plane.ts";

export {
  down as downDurableEventDelivery,
  up as upDurableEventDelivery,
} from "./002_durable_event_delivery.ts";

export {
  down as downExplicitSessionMailbox,
  up as upExplicitSessionMailbox,
} from "./003_explicit_session_mailbox.ts";

export {
  down as downSupervisorConnectionHealth,
  up as upSupervisorConnectionHealth,
} from "./004_supervisor_connection_health.ts";

export {
  down as downSupervisorBootCredentials,
  up as upSupervisorBootCredentials,
} from "./005_supervisor_boot_credentials.ts";

export {
  down as downPrivateMultiTenantIdentity,
  up as upPrivateMultiTenantIdentity,
} from "./006_private_multi_tenant_identity.ts";

export {
  down as downEncryptedTenantModelCredentials,
  up as upEncryptedTenantModelCredentials,
} from "./007_encrypted_tenant_model_credentials.ts";

export {
  down as downControlledWorkspaceSources,
  up as upControlledWorkspaceSources,
} from "./008_controlled_workspace_sources.ts";

export {
  down as downDurableRunsAndAttempts,
  up as upDurableRunsAndAttempts,
} from "./009_durable_runs_and_attempts.ts";

export {
  down as downVersionedWorkspacesAndGitHubDelivery,
  up as upVersionedWorkspacesAndGitHubDelivery,
} from "./010_versioned_workspaces_and_github_delivery.ts";

export {
  down as downContextAndModelGovernance,
  up as upContextAndModelGovernance,
} from "./011_context_and_model_governance.ts";

export {
  down as downObservabilityTraceIdentity,
  up as upObservabilityTraceIdentity,
} from "./012_observability_trace_identity.ts";

export {
  down as downProductAuthAndEmptyWorkspaces,
  up as upProductAuthAndEmptyWorkspaces,
} from "./013_product_auth_and_empty_workspaces.ts";

export {
  down as downRemovePerRunTokenBudget,
  up as upRemovePerRunTokenBudget,
} from "./014_remove_per_run_token_budget.ts";

export {
  down as downVersionedProjectEnvironments,
  up as upVersionedProjectEnvironments,
} from "./015_versioned_project_environments.ts";

export {
  down as downEnvironmentRecipesAndOperations,
  up as upEnvironmentRecipesAndOperations,
} from "./016_environment_recipes_and_operations.ts";

export {
  down as downMultiRepositorySourceSets,
  up as upMultiRepositorySourceSets,
} from "./017_multi_repository_source_sets.ts";

export {
  down as downLegacyEnvironmentValidationEvidence,
  up as upLegacyEnvironmentValidationEvidence,
} from "./019_legacy_environment_validation_evidence.ts";

export {
  down as downSemanticConversationProjections,
  up as upSemanticConversationProjections,
} from "./020_semantic_conversation_projections.ts";

export {
  down as downHorizontalSupervisorPool,
  up as upHorizontalSupervisorPool,
} from "./022_horizontal_supervisor_pool.ts";

export {
  down as downHotPlatformRuntimeSettings,
  up as upHotPlatformRuntimeSettings,
} from "./024_hot_platform_runtime_settings.ts";

export {
  down as downLargeWorkspaceCheckpoints,
  up as upLargeWorkspaceCheckpoints,
} from "./025_large_workspace_checkpoints.ts";

export {
  down as downWorkspaceFirstConversations,
  up as upWorkspaceFirstConversations,
} from "./026_workspace_first_conversations.ts";

export {
  down as downSharedWorkspaceHeads,
  up as upSharedWorkspaceHeads,
} from "./027_shared_workspace_heads.ts";

export {
  down as downInterruptedPiConversations,
  up as upInterruptedPiConversations,
} from "./028_interrupted_pi_conversations.ts";

export {
  down as downExternalPlatformGitMetadata,
  up as upExternalPlatformGitMetadata,
} from "./029_external_platform_git_metadata.ts";

export {
  down as downTypedToolOutcomes,
  up as upTypedToolOutcomes,
} from "./031_typed_tool_outcomes.ts";

export {
  down as downModelSamplingStepIdentity,
  up as upModelSamplingStepIdentity,
} from "./032_model_sampling_step_identity.ts";

export {
  down as downToolBrokerOwnership,
  up as upToolBrokerOwnership,
} from "./034_sandbox_manager_ownership.ts";

export {
  down as downPartitionedSessionEventLog,
  up as upPartitionedSessionEventLog,
} from "./035_partitioned_session_event_log.ts";

export {
  down as downSandboxDomainsAndToolBroker,
  up as upSandboxDomainsAndToolBroker,
} from "./045_sandbox_domains_and_tool_broker.ts";

export {
  down as downFasterEventIdentityRegistration,
  up as upFasterEventIdentityRegistration,
} from "./036_faster_event_identity_registration.ts";

export {
  down as downExternalWorkerEventLog,
  up as upExternalWorkerEventLog,
} from "./039_external_worker_event_log.ts";
export {
  down as downSessionSandboxRetention,
  up as upSessionSandboxRetention,
} from "./040_session_sandbox_retention.ts";
export {
  down as downDecouplePersistentSandboxLeases,
  up as upDecouplePersistentSandboxLeases,
} from "./041_decouple_persistent_sandbox_leases.ts";
export {
  down as downCanonicalConversationsAndLiveStreams,
  up as upCanonicalConversationsAndLiveStreams,
} from "./044_canonical_conversations_and_live_streams.ts";
export {
  down as downTurnAdmissionIndex,
  up as upTurnAdmissionIndex,
} from "./048_turn_admission_index.ts";

export {
  down as downTenantSandboxQuota,
  up as upTenantSandboxQuota,
} from "./049_tenant_sandbox_quota.ts";

export {
  down as downPrimaryToolBrokerRoute,
  up as upPrimaryToolBrokerRoute,
} from "./050_primary_tool_broker_route.ts";

export {
  down as downBootstrapTenantSandboxQuota,
  up as upBootstrapTenantSandboxQuota,
} from "./051_bootstrap_tenant_sandbox_quota.ts";

export {
  down as downUnlimitedDefaultDailyTokens,
  up as upUnlimitedDefaultDailyTokens,
} from "./055_unlimited_default_daily_tokens.ts";

export {
  down as downCodingRunModelRequestLimit,
  up as upCodingRunModelRequestLimit,
} from "./056_coding_run_model_request_limit.ts";

export {
  down as downConversationTreeForks,
  up as upConversationTreeForks,
} from "./057_conversation_tree_forks.ts";

export {
  down as downWorkspaceDeletion,
  up as upWorkspaceDeletion,
} from "./058_workspace_deletion.ts";

export {
  down as downRemoveDormantAdvancedFeatures,
  up as upRemoveDormantAdvancedFeatures,
} from "./061_remove_dormant_advanced_features.ts";
export {
  down as downPostgresSessionStorageOnly,
  up as upPostgresSessionStorageOnly,
} from "./062_postgres_session_storage_only.ts";
export {
  down as downPiCloudEnvironmentProfile,
  up as upPiCloudEnvironmentProfile,
} from "./063_pi_cloud_environment_profile.ts";
export {
  down as downPiCloudRunQueueNotification,
  up as upPiCloudRunQueueNotification,
} from "./064_pi_cloud_run_queue_notification.ts";
export {
  down as downRunToolCapabilitySnapshots,
  up as upRunToolCapabilitySnapshots,
} from "./065_run_tool_capability_snapshots.ts";
