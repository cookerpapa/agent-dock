import { Type, type Static } from "typebox";

export const DevelopmentEnvironmentProfileKeySchema = Type.Union([
  Type.Literal("starter"),
  Type.Literal("standard"),
  Type.Literal("performance"),
]);

export type DevelopmentEnvironmentProfileKey = Static<
  typeof DevelopmentEnvironmentProfileKeySchema
>;

export const DEVELOPMENT_ENVIRONMENT_PROFILES = Object.freeze([
  Object.freeze({
    key: "starter" as const,
    label: "轻量型",
    cpuCount: 1,
    memoryMiB: 2_048,
    systemDiskGiB: 8,
  }),
  Object.freeze({
    key: "standard" as const,
    label: "标准型",
    cpuCount: 2,
    memoryMiB: 4_096,
    systemDiskGiB: 16,
  }),
  Object.freeze({
    key: "performance" as const,
    label: "性能型",
    cpuCount: 4,
    memoryMiB: 8_192,
    systemDiskGiB: 32,
  }),
]);
