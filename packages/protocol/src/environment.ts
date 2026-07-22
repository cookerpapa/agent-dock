import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  PositiveSafeIntegerSchema,
  UtcTimestampSchema,
  UuidSchema,
} from "./protocol-primitives.ts";

export const DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY = "agent-dock-fullstack" as const;
export const DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION = "1" as const;
export const DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256 =
  "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630" as const;

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
    tools: Type.Array(EnvironmentToolReportSchema, {
      minItems: 4,
      maxItems: 4,
    }),
  },
  { additionalProperties: false },
);

export const EnvironmentValidationReportSchema = Type.Object(
  {
    profileKey: Type.Literal(DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY),
    profileVersion: Type.Literal(DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION),
    imageRevision: EnvironmentImageRevisionSchema,
    specSha256: Type.Literal(DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256),
    isolationBoundary: Type.Literal("gvisor"),
    runtime: Type.Literal("runsc"),
    networkMode: Type.Literal("deny_all"),
    runAsUser: Type.Literal("1000:1000"),
    readOnlyRootFilesystem: Type.Literal(true),
    tools: Type.Array(EnvironmentToolReportSchema, {
      minItems: 4,
      maxItems: 4,
    }),
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
    state: Type.Union([Type.Literal("pending"), Type.Literal("validated"), Type.Literal("failed")]),
    createdAt: UtcTimestampSchema,
    validatedAt: Type.Optional(UtcTimestampSchema),
    latestValidation: Type.Optional(EnvironmentValidationReportSchema),
  },
  { additionalProperties: false },
);

export type EnvironmentRuntimeSnapshot = Static<typeof EnvironmentRuntimeSnapshotSchema>;
export type EnvironmentToolName = Static<typeof EnvironmentToolNameSchema>;
export type EnvironmentToolReport = Static<typeof EnvironmentToolReportSchema>;
export type EnvironmentToolchainReport = Static<typeof EnvironmentToolchainReportSchema>;
export type EnvironmentValidationReport = Static<typeof EnvironmentValidationReportSchema>;
export type ProjectEnvironmentResource = Static<typeof ProjectEnvironmentResourceSchema>;

export function parseEnvironmentRuntimeSnapshot(value: unknown): EnvironmentRuntimeSnapshot {
  return Value.Parse(EnvironmentRuntimeSnapshotSchema, value);
}

export function parseEnvironmentToolchainReport(value: unknown): EnvironmentToolchainReport {
  return Value.Parse(EnvironmentToolchainReportSchema, value);
}

export function parseEnvironmentValidationReport(value: unknown): EnvironmentValidationReport {
  return Value.Parse(EnvironmentValidationReportSchema, value);
}

export function isExpectedDefaultToolchain(report: EnvironmentToolchainReport): boolean {
  const versions = new Map(report.tools.map((tool) => [tool.name, tool.version]));
  return (
    report.profileKey === DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY &&
    report.profileVersion === DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION &&
    report.specSha256 === DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256 &&
    report.tools.length === 4 &&
    /^v24\./.test(versions.get("node") ?? "") &&
    /version\s+"17(?:\.|\")/.test(versions.get("java") ?? "") &&
    /^Python 3\.11\./.test(versions.get("python") ?? "") &&
    /^git version 2\./.test(versions.get("git") ?? "")
  );
}
