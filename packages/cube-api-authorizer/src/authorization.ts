import { createHash, timingSafeEqual } from "node:crypto";

export type CubeAuthorizationRequest = Readonly<{
  authorization?: string;
  apiKey?: string;
  requestPath?: string;
  requestMethod?: string;
}>;

const SANDBOX_ID = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,126}[A-Za-z0-9])?";
const SANDBOX_ITEM_PATH = new RegExp(`^/sandboxes/${SANDBOX_ID}$`);
const SANDBOX_LIFECYCLE_PATH = new RegExp(`^/sandboxes/${SANDBOX_ID}/(?:pause|connect)$`);
const SANDBOX_SNAPSHOT_PATH = new RegExp(`^/sandboxes/${SANDBOX_ID}/snapshots$`);
const SNAPSHOT_ITEM_PATH = /^\/templates\/snap-[a-f0-9]{24}$/;
const WORKSPACE_VOLUME_ITEM_PATH = /^\/volumes\/adw-[a-f0-9]{48}$/;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function credential(request: CubeAuthorizationRequest): string | undefined {
  if (request.authorization?.startsWith("Bearer ") === true) {
    const value = request.authorization.slice("Bearer ".length).trim();
    return value.length === 0 ? undefined : value;
  }
  const value = request.apiKey?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

export function isAllowedCubeApiOperation(path: string, method: string): boolean {
  const normalizedMethod = method.toUpperCase();
  let parsed: URL;
  try {
    parsed = new URL(path, "http://cube-api.internal");
  } catch {
    return false;
  }
  if (parsed.origin !== "http://cube-api.internal" || parsed.hash !== "") return false;
  if (normalizedMethod === "POST" && parsed.pathname === "/sandboxes" && parsed.search === "") {
    return true;
  }
  if (normalizedMethod === "POST" && parsed.pathname === "/volumes" && parsed.search === "") {
    return true;
  }
  if (
    normalizedMethod === "GET" &&
    WORKSPACE_VOLUME_ITEM_PATH.test(parsed.pathname) &&
    parsed.search === ""
  ) {
    return true;
  }
  if (
    (normalizedMethod === "GET" || normalizedMethod === "DELETE") &&
    SANDBOX_ITEM_PATH.test(parsed.pathname) &&
    parsed.search === ""
  ) {
    return true;
  }
  if (
    normalizedMethod === "POST" &&
    SANDBOX_LIFECYCLE_PATH.test(parsed.pathname) &&
    parsed.search === ""
  ) {
    return true;
  }
  if (
    normalizedMethod === "POST" &&
    SANDBOX_SNAPSHOT_PATH.test(parsed.pathname) &&
    parsed.search === ""
  ) {
    return true;
  }
  if (
    normalizedMethod === "DELETE" &&
    SNAPSHOT_ITEM_PATH.test(parsed.pathname) &&
    parsed.search === ""
  ) {
    return true;
  }
  if (normalizedMethod === "GET" && parsed.pathname === "/snapshots") {
    if (parsed.search === "") return true;
    if ([...parsed.searchParams.keys()].some((key) => key !== "limit" && key !== "nextToken")) {
      return false;
    }
    const limits = parsed.searchParams.getAll("limit");
    const limit = limits[0];
    if (
      limits.length > 1 ||
      (limits.length === 1 && (limit === undefined || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(limit)))
    ) {
      return false;
    }
    const nextTokens = parsed.searchParams.getAll("nextToken");
    const nextToken = nextTokens[0];
    if (
      nextTokens.length > 1 ||
      (nextTokens.length === 1 &&
        (nextToken === undefined ||
          nextToken.length < 1 ||
          nextToken.length > 4_096 ||
          /[\u0000-\u001f\u007f]/.test(nextToken)))
    ) {
      return false;
    }
    return limits.length === 1 || nextTokens.length === 1;
  }
  if (normalizedMethod === "GET" && parsed.pathname === "/v2/sandboxes") {
    if (parsed.search === "") return true;
    if ([...parsed.searchParams.keys()].some((key) => key !== "limit")) return false;
    const limit = parsed.searchParams.get("limit");
    return limit !== null && /^(?:[1-9][0-9]{0,2}|1000)$/.test(limit);
  }
  return false;
}

export function authorizeCubeApiRequest(
  expectedCredential: string,
  request: CubeAuthorizationRequest,
): "allow" | "invalid_credential" | "operation_denied" {
  const supplied = credential(request);
  if (
    supplied === undefined ||
    supplied.length > 4_096 ||
    !timingSafeEqual(digest(supplied), digest(expectedCredential))
  ) {
    return "invalid_credential";
  }
  if (
    request.requestPath === undefined ||
    request.requestMethod === undefined ||
    request.requestPath.length > 2_048 ||
    request.requestMethod.length > 16 ||
    !isAllowedCubeApiOperation(request.requestPath, request.requestMethod)
  ) {
    return "operation_denied";
  }
  return "allow";
}
