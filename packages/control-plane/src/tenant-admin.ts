import { createDatabase, type TenantApiCredentialRole } from "@agent-dock/database";
import { pathToFileURL } from "node:url";
import {
  createPrivateTenant,
  issuePrivateTenantCredential,
  listPrivateTenantCredentials,
  revokePrivateTenantCredential,
} from "./tenant-administration.ts";
import {
  loadProductionDatabaseUrl,
  type ProductionControlPlaneEnvironment,
} from "./production-config.ts";

type Output = { write(value: string): unknown };

function parseFlags(values: readonly string[]): ReadonlyMap<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (flag === undefined || value === undefined || !/^--[a-z][a-z0-9-]*$/.test(flag)) {
      throw new TypeError("Tenant administration flags must use --name value pairs");
    }
    if (flags.has(flag)) throw new TypeError(`Duplicate tenant administration flag: ${flag}`);
    if (value.length < 1 || value.length > 1_024 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new TypeError(`Tenant administration value is invalid: ${flag}`);
    }
    flags.set(flag, value);
  }
  return flags;
}

function required(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined)
    throw new TypeError(`Required tenant administration flag is missing: ${name}`);
  return value;
}

function allowed(flags: ReadonlyMap<string, string>, names: readonly string[]): void {
  const permitted = new Set(names);
  for (const name of flags.keys()) {
    if (!permitted.has(name)) throw new TypeError(`Unknown tenant administration flag: ${name}`);
  }
}

function optionalInteger(
  flags: ReadonlyMap<string, string>,
  name: string,
  maximum: number,
): number | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new TypeError(`${name} must be an integer from 1 to ${String(maximum)}`);
  }
  return parsed;
}

function role(value: string): TenantApiCredentialRole {
  if (value !== "owner" && value !== "member" && value !== "viewer") {
    throw new TypeError("--role must be owner, member, or viewer");
  }
  return value;
}

function expiration(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new TypeError("--expires-at must be an exact ISO-8601 timestamp");
  }
  return parsed;
}

export async function runTenantAdministration(
  args: readonly string[],
  environment: ProductionControlPlaneEnvironment = process.env,
  output: Output = process.stdout,
): Promise<void> {
  const [command, ...rawFlags] = args;
  if (command === undefined) {
    throw new TypeError("Usage: tenant-admin <create|issue|revoke|list> [--flag value]");
  }
  const flags = parseFlags(rawFlags);
  const database = createDatabase({
    connectionString: await loadProductionDatabaseUrl(environment),
    maxConnections: 2,
  });
  try {
    if (command === "create") {
      allowed(flags, [
        "--slug",
        "--display-name",
        "--credential-label",
        "--maximum-projects",
        "--maximum-sessions",
        "--maximum-unsettled-turns",
        "--maximum-concurrent-turns",
        "--maximum-active-sandboxes",
      ]);
      const maximumProjects = optionalInteger(flags, "--maximum-projects", 1_000_000);
      const maximumSessions = optionalInteger(flags, "--maximum-sessions", 1_000_000);
      const maximumUnsettledTurns = optionalInteger(flags, "--maximum-unsettled-turns", 1_000_000);
      const maximumConcurrentTurns = optionalInteger(flags, "--maximum-concurrent-turns", 256);
      const maximumActiveSandboxes = optionalInteger(
        flags,
        "--maximum-active-sandboxes",
        1_000_000,
      );
      const created = await createPrivateTenant(database, {
        slug: required(flags, "--slug"),
        ownerDisplayName: required(flags, "--display-name"),
        ...(flags.get("--credential-label") === undefined
          ? {}
          : { ownerCredentialLabel: flags.get("--credential-label")! }),
        quotas: {
          ...(maximumProjects === undefined ? {} : { maximumProjects }),
          ...(maximumSessions === undefined ? {} : { maximumSessions }),
          ...(maximumUnsettledTurns === undefined ? {} : { maximumUnsettledTurns }),
          ...(maximumConcurrentTurns === undefined ? {} : { maximumConcurrentTurns }),
          ...(maximumActiveSandboxes === undefined ? {} : { maximumActiveSandboxes }),
        },
      });
      const { credential: generatedCredential, ...tenant } = created;
      const { secretSha256: _secretSha256, ...credential } = generatedCredential;
      output.write(
        `${JSON.stringify({
          operation: "tenant.created",
          ...tenant,
          credential,
        })}\n`,
      );
      return;
    }
    if (command === "issue") {
      allowed(flags, ["--tenant", "--user-id", "--label", "--role", "--expires-at"]);
      const expiresAt = expiration(flags.get("--expires-at"));
      const credential = await issuePrivateTenantCredential(database, {
        tenant: required(flags, "--tenant"),
        userId: required(flags, "--user-id"),
        label: required(flags, "--label"),
        role: role(required(flags, "--role")),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      output.write(
        `${JSON.stringify({
          operation: "credential.issued",
          credential: {
            credentialId: credential.credentialId,
            token: credential.token,
          },
        })}\n`,
      );
      return;
    }
    if (command === "revoke") {
      allowed(flags, ["--tenant", "--credential-id"]);
      const revoked = await revokePrivateTenantCredential(database, {
        tenant: required(flags, "--tenant"),
        credentialId: required(flags, "--credential-id"),
      });
      output.write(
        `${JSON.stringify({
          operation: "credential.revoked",
          credentialId: required(flags, "--credential-id"),
          revoked,
        })}\n`,
      );
      return;
    }
    if (command === "list") {
      allowed(flags, ["--tenant"]);
      const credentials = await listPrivateTenantCredentials(database, required(flags, "--tenant"));
      output.write(`${JSON.stringify({ operation: "credential.listed", credentials })}\n`);
      return;
    }
    throw new TypeError("Unknown tenant administration command");
  } finally {
    await database.destroy();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runTenantAdministration(process.argv.slice(2)).catch(() => {
    process.stderr.write("AgentDock tenant administration failed\n");
    process.exitCode = 1;
  });
}
