import { describe, expect, it } from "vitest";
import { authorizeCubeApiRequest, isAllowedCubeApiOperation } from "../src/authorization.ts";

const CREDENTIAL = "a".repeat(64);
const SANDBOX = "sandbox-123";

describe("Cube API authorizer", () => {
  it.each([
    ["POST", "/sandboxes"],
    ["GET", `/sandboxes/${SANDBOX}`],
    ["DELETE", `/sandboxes/${SANDBOX}`],
    ["POST", `/sandboxes/${SANDBOX}/pause`],
    ["POST", `/sandboxes/${SANDBOX}/connect`],
    ["POST", `/sandboxes/${SANDBOX}/snapshots`],
    ["DELETE", "/templates/snap-0123456789abcdef01234567"],
    ["GET", "/v2/sandboxes"],
    ["GET", "/v2/sandboxes?limit=1000"],
  ])("allows the Provider operation %s %s", (method, path) => {
    expect(isAllowedCubeApiOperation(path, method)).toBe(true);
    expect(
      authorizeCubeApiRequest(CREDENTIAL, {
        authorization: `Bearer ${CREDENTIAL}`,
        requestPath: path,
        requestMethod: method,
      }),
    ).toBe("allow");
  });

  it.each([
    ["GET", "/templates"],
    ["DELETE", "/templates/tpl-owned"],
    ["DELETE", "/templates/snap-owned"],
    ["DELETE", "/templates/snap-0123456789abcdef0123456g"],
    ["GET", `/sandboxes/${SANDBOX}/snapshots`],
    ["PATCH", `/sandboxes/${SANDBOX}`],
    ["POST", `/sandboxes/${SANDBOX}`],
    ["GET", "/v2/sandboxes?limit=1001"],
    ["GET", "/v2/sandboxes?owner=another-tenant"],
    ["POST", "/sandboxes?unsafe=true"],
  ])("denies the operation %s %s", (method, path) => {
    expect(isAllowedCubeApiOperation(path, method)).toBe(false);
    expect(
      authorizeCubeApiRequest(CREDENTIAL, {
        apiKey: CREDENTIAL,
        requestPath: path,
        requestMethod: method,
      }),
    ).toBe("operation_denied");
  });

  it("rejects missing and incorrect credentials before operation policy", () => {
    expect(
      authorizeCubeApiRequest(CREDENTIAL, {
        requestPath: "/sandboxes",
        requestMethod: "POST",
      }),
    ).toBe("invalid_credential");
    expect(
      authorizeCubeApiRequest(CREDENTIAL, {
        authorization: `Bearer ${"b".repeat(64)}`,
        requestPath: "/sandboxes",
        requestMethod: "POST",
      }),
    ).toBe("invalid_credential");
  });
});
