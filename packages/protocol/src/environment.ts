import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  NonNegativeSafeIntegerSchema,
  PositiveSafeIntegerSchema,
  UtcTimestampSchema,
  UuidSchema,
} from "./protocol-primitives.ts";

export const DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY = "pi-cloud-fullstack" as const;
export const DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION = "1" as const;
export const DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256 =
  "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630" as const;
export const DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256 =
  "2d6c5260fe7bc3901e454ff93106dc5ed263d6edbbabf7bafdf852021289e5ba" as const;

const EnvironmentCommandIdSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$",
});

const EnvironmentCommandWorkingDirectorySchema = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: "^(?:\\.|[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*)$",
});

export const DependencyHostnameSchema = Type.String({
  minLength: 4,
  maxLength: 253,
  pattern: "^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$",
});

export const EnvironmentRecipeCommandSchema = Type.Object(
  {
    id: EnvironmentCommandIdSchema,
    command: Type.String({ minLength: 1, maxLength: 4_096 }),
    cwd: EnvironmentCommandWorkingDirectorySchema,
    timeoutMs: Type.Integer({ minimum: 100, maximum: 300_000 }),
    network: Type.Union([Type.Literal("none"), Type.Literal("dependency")]),
  },
  { additionalProperties: false },
);

export const EnvironmentRecipeSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    dependencyHosts: Type.Optional(
      Type.Array(DependencyHostnameSchema, { minItems: 1, maxItems: 32, uniqueItems: true }),
    ),
    setupCommands: Type.Array(EnvironmentRecipeCommandSchema, { maxItems: 10 }),
    verificationCommands: Type.Array(EnvironmentRecipeCommandSchema, {
      minItems: 1,
      maxItems: 10,
    }),
  },
  { additionalProperties: false },
);

export const DEFAULT_PROJECT_ENVIRONMENT_RECIPE = {
  schemaVersion: 1,
  setupCommands: [],
  verificationCommands: [
    {
      id: "workspace-root",
      command: 'test "$PWD" = /workspace && test -w .',
      cwd: ".",
      timeoutMs: 10_000,
      network: "none",
    },
  ],
} as const satisfies Static<typeof EnvironmentRecipeSchema>;

export const EnvironmentRecipeCommandResultSchema = Type.Object(
  {
    id: EnvironmentCommandIdSchema,
    phase: Type.Union([Type.Literal("setup"), Type.Literal("verification")]),
    exitCode: Type.Integer({ minimum: 0, maximum: 255 }),
    durationMs: NonNegativeSafeIntegerSchema,
    outputSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    outputSummary: Type.Optional(Type.String({ maxLength: 512 })),
  },
  { additionalProperties: false },
);

export const EnvironmentImageRevisionSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
});

export const EnvironmentRuntimeSnapshotSchema = Type.Object(
  {
    environmentVersionId: UuidSchema,
    versionNumber: PositiveSafeIntegerSchema,
    profileKey: Type.Literal(DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY),
    profileVersion: Type.Literal(DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION),
    imageRevision: EnvironmentImageRevisionSchema,
    specSha256: Type.Literal(DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256),
    recipe: EnvironmentRecipeSchema,
    recipeSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  },
  { additionalProperties: false },
);

export const EnvironmentToolNameSchema = Type.Union([
  Type.Literal("node"),
  Type.Literal("java"),
  Type.Literal("python"),
  Type.Literal("git"),
]);

export const EnvironmentToolReportSchema = Type.Object(
  {
    name: EnvironmentToolNameSchema,
    version: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
);

export const EnvironmentToolchainReportSchema = Type.Object(
  {
    profileKey: Type.Literal(DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY),
    profileVersion: Type.Literal(DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION),
    imageRevision: EnvironmentImageRevisionSchema,
    specSha256: Type.Literal(DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256),
    recipeSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    tools: Type.Array(EnvironmentToolReportSchema, {
      minItems: 4,
      maxItems: 4,
    }),
    recipeCommands: Type.Array(EnvironmentRecipeCommandResultSchema, { maxItems: 20 }),
  },
  { additionalProperties: false },
);

const EnvironmentValidationCommonSchema = {
  profileKey: Type.Literal(DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY),
  profileVersion: Type.Literal(DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION),
  imageRevision: EnvironmentImageRevisionSchema,
  specSha256: Type.Literal(DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256),
  recipeSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  runAsUser: Type.Literal("1000:1000"),
  tools: Type.Array(EnvironmentToolReportSchema, {
    minItems: 4,
    maxItems: 4,
  }),
  recipeCommands: Type.Array(EnvironmentRecipeCommandResultSchema, { maxItems: 20 }),
} as const;

export const EnvironmentValidationReportSchema = Type.Object(
  {
    ...EnvironmentValidationCommonSchema,
    isolationBoundary: Type.Literal("microvm"),
    runtime: Type.Literal("cubesandbox-kvm"),
    networkMode: Type.Literal("public_web_proxy_private_denied"),
    // Cube's disposable CoW guest rootfs is writable. The non-root Tool
    // Worker and the independent guest kernel are the effective boundary.
    readOnlyRootFilesystem: Type.Literal(false),
  },
  { additionalProperties: false },
);

export const ProjectEnvironmentResourceSchema = Type.Object(
  {
    environmentVersionId: UuidSchema,
    versionNumber: PositiveSafeIntegerSchema,
    profileKey: Type.Literal(DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY),
    profileVersion: Type.Literal(DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION),
    imageRevision: EnvironmentImageRevisionSchema,
    specSha256: Type.Literal(DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256),
    recipe: EnvironmentRecipeSchema,
    recipeSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    state: Type.Union([Type.Literal("pending"), Type.Literal("validated"), Type.Literal("failed")]),
    active: Type.Boolean(),
    createdAt: UtcTimestampSchema,
    validatedAt: Type.Optional(UtcTimestampSchema),
    latestValidation: Type.Optional(EnvironmentValidationReportSchema),
  },
  { additionalProperties: false },
);

export const CreateProjectEnvironmentVersionRequestSchema = Type.Object(
  { recipe: EnvironmentRecipeSchema },
  { additionalProperties: false },
);

export const ActivateProjectEnvironmentVersionRequestSchema = Type.Object(
  { expectedActiveEnvironmentVersionId: UuidSchema },
  { additionalProperties: false },
);

export const ProjectEnvironmentOperationResourceSchema = Type.Object(
  {
    operationId: UuidSchema,
    kind: Type.Union([
      Type.Literal("create"),
      Type.Literal("activate"),
      Type.Literal("rollback"),
      Type.Literal("validate"),
    ]),
    actorUserId: UuidSchema,
    fromEnvironmentVersionId: Type.Optional(UuidSchema),
    toEnvironmentVersionId: UuidSchema,
    createdAt: UtcTimestampSchema,
  },
  { additionalProperties: false },
);

export const ProjectEnvironmentHistoryResourceSchema = Type.Object(
  {
    projectId: UuidSchema,
    activeEnvironmentVersionId: UuidSchema,
    versions: Type.Array(ProjectEnvironmentResourceSchema, { maxItems: 100 }),
    operations: Type.Array(ProjectEnvironmentOperationResourceSchema, { maxItems: 100 }),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type EnvironmentRuntimeSnapshot = Static<typeof EnvironmentRuntimeSnapshotSchema>;
export type EnvironmentRecipe = Static<typeof EnvironmentRecipeSchema>;
export type EnvironmentRecipeCommand = Static<typeof EnvironmentRecipeCommandSchema>;
export type EnvironmentRecipeCommandResult = Static<typeof EnvironmentRecipeCommandResultSchema>;
export type EnvironmentToolName = Static<typeof EnvironmentToolNameSchema>;
export type EnvironmentToolReport = Static<typeof EnvironmentToolReportSchema>;
export type EnvironmentToolchainReport = Static<typeof EnvironmentToolchainReportSchema>;
export type EnvironmentValidationReport = Static<typeof EnvironmentValidationReportSchema>;
export type ProjectEnvironmentResource = Static<typeof ProjectEnvironmentResourceSchema>;
export type CreateProjectEnvironmentVersionRequest = Static<
  typeof CreateProjectEnvironmentVersionRequestSchema
>;
export type ActivateProjectEnvironmentVersionRequest = Static<
  typeof ActivateProjectEnvironmentVersionRequestSchema
>;
export type ProjectEnvironmentOperationResource = Static<
  typeof ProjectEnvironmentOperationResourceSchema
>;
export type ProjectEnvironmentHistoryResource = Static<
  typeof ProjectEnvironmentHistoryResourceSchema
>;

function assertEnvironmentRecipeSemantics(recipe: EnvironmentRecipe): void {
  const ids = new Set<string>();
  const commands = [...recipe.setupCommands, ...recipe.verificationCommands];
  if (commands.reduce((total, command) => total + command.timeoutMs, 0) > 10 * 60_000) {
    throw new TypeError("Environment recipe command budget exceeds ten minutes");
  }
  for (const command of commands) {
    if (ids.has(command.id))
      throw new TypeError(`Environment command ID ${command.id} is repeated`);
    ids.add(command.id);
    if (
      command.cwd !== "." &&
      command.cwd.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      throw new TypeError("Environment command working directory is not normalized");
    }
    if (new RegExp("[\\u0000-\\u001f\\u007f]").test(command.command)) {
      throw new TypeError("Environment command contains control characters");
    }
  }
  if (recipe.verificationCommands.some((command) => command.network === "dependency")) {
    throw new TypeError("Environment verification commands must run offline");
  }
  const requiresDependencyNetwork = recipe.setupCommands.some(
    (command) => command.network === "dependency",
  );
  const dependencyHosts = recipe.dependencyHosts ?? [];
  if (requiresDependencyNetwork !== dependencyHosts.length > 0) {
    throw new TypeError(
      "Environment dependency hosts must exist exactly when a command requests dependency network",
    );
  }
}

export function parseEnvironmentRecipe(value: unknown): EnvironmentRecipe {
  const recipe = Value.Parse(EnvironmentRecipeSchema, value);
  assertEnvironmentRecipeSemantics(recipe);
  return {
    ...recipe,
    ...(recipe.dependencyHosts === undefined
      ? {}
      : { dependencyHosts: [...recipe.dependencyHosts].sort() }),
  };
}

export function canonicalEnvironmentRecipeJson(value: unknown): string {
  const recipe = parseEnvironmentRecipe(value);
  return JSON.stringify({
    schemaVersion: 1,
    ...(recipe.dependencyHosts === undefined
      ? {}
      : { dependencyHosts: [...recipe.dependencyHosts] }),
    setupCommands: recipe.setupCommands.map((command) => ({
      id: command.id,
      command: command.command,
      cwd: command.cwd,
      timeoutMs: command.timeoutMs,
      network: command.network,
    })),
    verificationCommands: recipe.verificationCommands.map((command) => ({
      id: command.id,
      command: command.command,
      cwd: command.cwd,
      timeoutMs: command.timeoutMs,
      network: command.network,
    })),
  });
}

export function parseEnvironmentRuntimeSnapshot(value: unknown): EnvironmentRuntimeSnapshot {
  const snapshot = Value.Parse(EnvironmentRuntimeSnapshotSchema, value);
  return { ...snapshot, recipe: parseEnvironmentRecipe(snapshot.recipe) };
}

export function parseEnvironmentToolchainReport(value: unknown): EnvironmentToolchainReport {
  return Value.Parse(EnvironmentToolchainReportSchema, value);
}

export function parseEnvironmentValidationReport(value: unknown): EnvironmentValidationReport {
  return Value.Parse(EnvironmentValidationReportSchema, value);
}

export function parseCreateProjectEnvironmentVersionRequest(
  value: unknown,
): CreateProjectEnvironmentVersionRequest {
  const request = Value.Parse(CreateProjectEnvironmentVersionRequestSchema, value);
  return { recipe: parseEnvironmentRecipe(request.recipe) };
}

export function parseActivateProjectEnvironmentVersionRequest(
  value: unknown,
): ActivateProjectEnvironmentVersionRequest {
  return Value.Parse(ActivateProjectEnvironmentVersionRequestSchema, value);
}

export function parseProjectEnvironmentHistoryResource(
  value: unknown,
): ProjectEnvironmentHistoryResource {
  return Value.Parse(ProjectEnvironmentHistoryResourceSchema, value);
}

export function isExpectedDefaultToolchain(report: EnvironmentToolchainReport): boolean {
  const versions = new Map(report.tools.map((tool) => [tool.name, tool.version]));
  return (
    report.profileKey === DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY &&
    report.profileVersion === DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION &&
    report.specSha256 === DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256 &&
    /^[0-9a-f]{64}$/.test(report.recipeSha256) &&
    report.tools.length === 4 &&
    /^v24\./.test(versions.get("node") ?? "") &&
    /version\s+"17(?:\.|\")/.test(versions.get("java") ?? "") &&
    /^Python 3\.11\./.test(versions.get("python") ?? "") &&
    /^git version 2\./.test(versions.get("git") ?? "")
  );
}
