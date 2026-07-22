import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
  KeyObject,
} from "node:crypto";

export const DEPENDENCY_EGRESS_CAPABILITY_AUDIENCE = "agent-dock-dependency-egress" as const;
export const DEPENDENCY_EGRESS_CAPABILITY_ISSUER = "agent-dock-sandbox-manager" as const;
const TOKEN_PREFIX = "adpc1_";
const HOST_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type DependencyEgressCapabilityClaims = Readonly<{
  version: 1;
  issuer: typeof DEPENDENCY_EGRESS_CAPABILITY_ISSUER;
  audience: typeof DEPENDENCY_EGRESS_CAPABILITY_AUDIENCE;
  activationId: string;
  policySha256: string;
  hosts: readonly string[];
  notBefore: number;
  expiresAt: number;
  maximumConnections: number;
  maximumConcurrentConnections: number;
  maximumBytes: number;
  maximumConnectionDurationMs: number;
  nonce: string;
}>;

export type MintDependencyEgressCapabilityInput = Readonly<{
  privateKey: string | Buffer | KeyObject;
  activationId: string;
  hosts: readonly string[];
  nowMs?: number;
  ttlMs?: number;
  maximumConnections?: number;
  maximumConcurrentConnections?: number;
  maximumBytes?: number;
  maximumConnectionDurationMs?: number;
  nonce?: string;
}>;

export class DependencyEgressCapabilityError extends Error {
  readonly code: string;

  constructor(code: string, safeMessage: string) {
    super(safeMessage);
    this.name = "DependencyEgressCapabilityError";
    this.code = code;
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new DependencyEgressCapabilityError(
      "dependency_egress_capability_invalid",
      `${label} was invalid`,
    );
  }
  return value;
}

export function normalizeDependencyHosts(hosts: readonly string[]): readonly string[] {
  if (hosts.length < 1 || hosts.length > 32) {
    throw new DependencyEgressCapabilityError(
      "dependency_egress_policy_invalid",
      "Dependency host policy was invalid",
    );
  }
  const normalized = [...hosts].sort();
  if (
    normalized.some(
      (host, index) =>
        host.length > 253 ||
        !HOST_PATTERN.test(host) ||
        (index > 0 && normalized[index - 1] === host),
    )
  ) {
    throw new DependencyEgressCapabilityError(
      "dependency_egress_policy_invalid",
      "Dependency host policy was invalid",
    );
  }
  return normalized;
}

export function dependencyEgressPolicySha256(hosts: readonly string[]): string {
  return createHash("sha256")
    .update("agent-dock.dependency-egress-policy.v1\0", "utf8")
    .update(JSON.stringify(normalizeDependencyHosts(hosts)), "utf8")
    .digest("hex");
}

function canonicalClaimsJson(claims: DependencyEgressCapabilityClaims): string {
  return JSON.stringify({
    version: 1,
    issuer: claims.issuer,
    audience: claims.audience,
    activationId: claims.activationId,
    policySha256: claims.policySha256,
    hosts: [...claims.hosts],
    notBefore: claims.notBefore,
    expiresAt: claims.expiresAt,
    maximumConnections: claims.maximumConnections,
    maximumConcurrentConnections: claims.maximumConcurrentConnections,
    maximumBytes: claims.maximumBytes,
    maximumConnectionDurationMs: claims.maximumConnectionDurationMs,
    nonce: claims.nonce,
  });
}

function validateClaims(value: unknown): DependencyEgressCapabilityClaims {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DependencyEgressCapabilityError(
      "dependency_egress_capability_invalid",
      "Dependency egress capability was invalid",
    );
  }
  const claims = value as Partial<Record<keyof DependencyEgressCapabilityClaims, unknown>>;
  if (
    claims.version !== 1 ||
    claims.issuer !== DEPENDENCY_EGRESS_CAPABILITY_ISSUER ||
    claims.audience !== DEPENDENCY_EGRESS_CAPABILITY_AUDIENCE ||
    typeof claims.activationId !== "string" ||
    !UUID_PATTERN.test(claims.activationId) ||
    typeof claims.policySha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(claims.policySha256) ||
    !Array.isArray(claims.hosts) ||
    !claims.hosts.every((host): host is string => typeof host === "string") ||
    typeof claims.notBefore !== "number" ||
    typeof claims.expiresAt !== "number" ||
    typeof claims.maximumConnections !== "number" ||
    typeof claims.maximumConcurrentConnections !== "number" ||
    typeof claims.maximumBytes !== "number" ||
    typeof claims.maximumConnectionDurationMs !== "number" ||
    typeof claims.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{22,64}$/.test(claims.nonce)
  ) {
    throw new DependencyEgressCapabilityError(
      "dependency_egress_capability_invalid",
      "Dependency egress capability was invalid",
    );
  }
  const hosts = normalizeDependencyHosts(claims.hosts);
  if (
    dependencyEgressPolicySha256(hosts) !== claims.policySha256 ||
    JSON.stringify(hosts) !== JSON.stringify(claims.hosts)
  ) {
    throw new DependencyEgressCapabilityError(
      "dependency_egress_capability_invalid",
      "Dependency egress capability policy was invalid",
    );
  }
  const notBefore = boundedInteger(claims.notBefore, 0, 9_999_999_999_999, "notBefore");
  const expiresAt = boundedInteger(claims.expiresAt, 1, 9_999_999_999_999, "expiresAt");
  if (expiresAt <= notBefore || expiresAt - notBefore > 20 * 60_000 + 5_000) {
    throw new DependencyEgressCapabilityError(
      "dependency_egress_capability_invalid",
      "Dependency egress capability lifetime was invalid",
    );
  }
  return {
    version: 1,
    issuer: DEPENDENCY_EGRESS_CAPABILITY_ISSUER,
    audience: DEPENDENCY_EGRESS_CAPABILITY_AUDIENCE,
    activationId: claims.activationId,
    policySha256: claims.policySha256,
    hosts,
    notBefore,
    expiresAt,
    maximumConnections: boundedInteger(claims.maximumConnections, 1, 64, "maximumConnections"),
    maximumConcurrentConnections: boundedInteger(
      claims.maximumConcurrentConnections,
      1,
      8,
      "maximumConcurrentConnections",
    ),
    maximumBytes: boundedInteger(claims.maximumBytes, 1_024, 512 * 1_024 * 1_024, "maximumBytes"),
    maximumConnectionDurationMs: boundedInteger(
      claims.maximumConnectionDurationMs,
      1_000,
      5 * 60_000,
      "maximumConnectionDurationMs",
    ),
    nonce: claims.nonce,
  };
}

export function mintDependencyEgressCapability(input: MintDependencyEgressCapabilityInput): {
  token: string;
  claims: DependencyEgressCapabilityClaims;
} {
  const now = boundedInteger(input.nowMs ?? Date.now(), 0, 9_999_999_999_999, "nowMs");
  const ttlMs = boundedInteger(input.ttlMs ?? 15 * 60_000, 10_000, 20 * 60_000, "ttlMs");
  const hosts = normalizeDependencyHosts(input.hosts);
  const claims = validateClaims({
    version: 1,
    issuer: DEPENDENCY_EGRESS_CAPABILITY_ISSUER,
    audience: DEPENDENCY_EGRESS_CAPABILITY_AUDIENCE,
    activationId: input.activationId,
    policySha256: dependencyEgressPolicySha256(hosts),
    hosts,
    notBefore: now - 5_000,
    expiresAt: now + ttlMs,
    maximumConnections: input.maximumConnections ?? 16,
    maximumConcurrentConnections: input.maximumConcurrentConnections ?? 2,
    maximumBytes: input.maximumBytes ?? 128 * 1_024 * 1_024,
    maximumConnectionDurationMs: input.maximumConnectionDurationMs ?? 120_000,
    nonce: input.nonce ?? randomBytes(18).toString("base64url"),
  });
  const payload = Buffer.from(canonicalClaimsJson(claims), "utf8");
  const privateKey =
    input.privateKey instanceof KeyObject ? input.privateKey : createPrivateKey(input.privateKey);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new DependencyEgressCapabilityError(
      "dependency_egress_issuer_invalid",
      "Dependency egress issuer key was invalid",
    );
  }
  const signature = sign(null, payload, privateKey);
  return {
    token: `${TOKEN_PREFIX}${payload.toString("base64url")}.${signature.toString("base64url")}`,
    claims,
  };
}

export function verifyDependencyEgressCapability(
  token: string,
  publicKeyInput: string | Buffer | KeyObject,
  nowMs = Date.now(),
): DependencyEgressCapabilityClaims {
  if (token.length < 128 || token.length > 16_384 || !token.startsWith(TOKEN_PREFIX)) {
    throw new DependencyEgressCapabilityError(
      "dependency_egress_capability_invalid",
      "Dependency egress capability was invalid",
    );
  }
  const encoded = token.slice(TOKEN_PREFIX.length).split(".");
  if (
    encoded.length !== 2 ||
    !/^[A-Za-z0-9_-]+$/.test(encoded[0] ?? "") ||
    !/^[A-Za-z0-9_-]{86}$/.test(encoded[1] ?? "")
  ) {
    throw new DependencyEgressCapabilityError(
      "dependency_egress_capability_invalid",
      "Dependency egress capability was invalid",
    );
  }
  const payload = Buffer.from(encoded[0]!, "base64url");
  const signature = Buffer.from(encoded[1]!, "base64url");
  if (
    payload.byteLength < 128 ||
    payload.byteLength > 12_000 ||
    signature.byteLength !== 64 ||
    payload.toString("base64url") !== encoded[0] ||
    signature.toString("base64url") !== encoded[1]
  ) {
    throw new DependencyEgressCapabilityError(
      "dependency_egress_capability_invalid",
      "Dependency egress capability was invalid",
    );
  }
  const publicKey =
    publicKeyInput instanceof KeyObject ? publicKeyInput : createPublicKey(publicKeyInput);
  if (publicKey.asymmetricKeyType !== "ed25519" || !verify(null, payload, publicKey, signature)) {
    throw new DependencyEgressCapabilityError(
      "dependency_egress_capability_invalid",
      "Dependency egress capability signature was invalid",
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload.toString("utf8")) as unknown;
  } catch {
    throw new DependencyEgressCapabilityError(
      "dependency_egress_capability_invalid",
      "Dependency egress capability payload was invalid",
    );
  }
  const claims = validateClaims(decoded);
  if (payload.toString("utf8") !== canonicalClaimsJson(claims)) {
    throw new DependencyEgressCapabilityError(
      "dependency_egress_capability_invalid",
      "Dependency egress capability was not canonical",
    );
  }
  const now = boundedInteger(nowMs, 0, 9_999_999_999_999, "nowMs");
  if (now < claims.notBefore || now >= claims.expiresAt) {
    throw new DependencyEgressCapabilityError(
      "dependency_egress_capability_expired",
      "Dependency egress capability was not active",
    );
  }
  return claims;
}

export function dependencyEgressPublicKeyPem(privateKeyInput: string | Buffer | KeyObject): string {
  const privateKey =
    privateKeyInput instanceof KeyObject ? privateKeyInput : createPrivateKey(privateKeyInput);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new DependencyEgressCapabilityError(
      "dependency_egress_issuer_invalid",
      "Dependency egress issuer key was invalid",
    );
  }
  return createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
}

export function dependencyEgressPublicKeyFingerprint(publicKeyPem: string | Buffer): string {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new DependencyEgressCapabilityError(
      "dependency_egress_issuer_invalid",
      "Dependency egress issuer key was invalid",
    );
  }
  return createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
}
