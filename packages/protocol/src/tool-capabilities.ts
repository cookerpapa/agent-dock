import { Type } from "typebox";
import { Value } from "typebox/value";

export const CLOUD_TOOL_NAMES = ["read", "write", "edit", "bash"] as const;

export const CloudToolNameSchema = Type.Union([
  Type.Literal("read"),
  Type.Literal("write"),
  Type.Literal("edit"),
  Type.Literal("bash"),
]);
export type CloudToolName = (typeof CLOUD_TOOL_NAMES)[number];

export const CloudToolCapabilitySnapshotSchema = Type.Array(CloudToolNameSchema, {
  minItems: 0,
  maxItems: CLOUD_TOOL_NAMES.length,
  uniqueItems: true,
});
export type CloudToolCapabilitySnapshot = CloudToolName[];

/** Validate and canonicalize one credential-free built-in Tool grant. */
export function parseCloudToolCapabilitySnapshot(value: unknown): CloudToolCapabilitySnapshot {
  if (!Value.Check(CloudToolCapabilitySnapshotSchema, value)) {
    throw new TypeError("Cloud Tool capability snapshot is invalid");
  }
  const selected = new Set(value as CloudToolName[]);
  return CLOUD_TOOL_NAMES.filter((name) => selected.has(name));
}
