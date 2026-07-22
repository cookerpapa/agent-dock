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
  down as downAttemptRewindsAndReviewBundles,
  up as upAttemptRewindsAndReviewBundles,
} from "./018_attempt_rewinds_and_review_bundles.ts";
