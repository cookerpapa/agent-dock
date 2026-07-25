import { describe, expect, it } from "vitest";
import {
  AgentDockInternalProtocolError,
  parseSupervisorBootProvisionRequest,
  parseSupervisorManagementRequest,
  parseSupervisorManagementResponse,
} from "../src/index.ts";

const IDS = {
  request: "11111111-1111-4111-8111-111111111111",
  boot: "22222222-2222-4222-8222-222222222222",
  sandbox: "33333333-3333-4333-8333-333333333333",
  credential: "44444444-4444-4444-8444-444444444444",
  lease: "55555555-5555-4555-8555-555555555555",
};

describe("Supervisor internal management protocol", () => {
  it("accepts a closed boot provision request", () => {
    expect(
      parseSupervisorBootProvisionRequest({
        protocolVersion: 1,
        type: "supervisor.boot.provision",
        requestId: IDS.request,
        supervisorId: "supervisor-host-1",
        bootId: IDS.boot,
        sandboxId: IDS.sandbox,
        credentialId: IDS.credential,
        credentialSha256: "a".repeat(64),
        maxConcurrentSessions: 2,
        managementBaseUrl: "http://supervisor-host-1:4100",
      }),
    ).toMatchObject({ bootId: IDS.boot, maxConcurrentSessions: 2 });
  });

  it("rejects unknown provision fields and oversized capacity", () => {
    expect(() =>
      parseSupervisorBootProvisionRequest({
        protocolVersion: 1,
        type: "supervisor.boot.provision",
        requestId: IDS.request,
        supervisorId: "supervisor-host-1",
        bootId: IDS.boot,
        sandboxId: IDS.sandbox,
        credentialId: IDS.credential,
        credentialSha256: "a".repeat(64),
        maxConcurrentSessions: 257,
        managementBaseUrl: "http://supervisor-host-1:4100",
        ownerUrl: "http://attacker.invalid",
      }),
    ).toThrow(AgentDockInternalProtocolError);
  });

  it("round-trips exact assignment management identity", () => {
    const assignment = {
      containerId: "66666666-6666-4666-8666-666666666666",
      containerName: "agent-dock-test",
      supervisorId: "supervisor-host-1",
      bootId: IDS.boot,
      sandboxId: IDS.sandbox,
      commandId: IDS.credential,
      sessionId: IDS.request,
      turnId: IDS.boot,
      leaseId: IDS.lease,
      fencingToken: 7,
    };
    expect(
      parseSupervisorManagementRequest({
        protocolVersion: 1,
        type: "assignment.terminate_and_confirm",
        requestId: IDS.request,
        sandboxId: IDS.sandbox,
        assignment,
      }),
    ).toMatchObject({ assignment });
    expect(
      parseSupervisorManagementResponse({
        protocolVersion: 1,
        type: "assignments.listed",
        requestId: IDS.request,
        sandboxId: IDS.sandbox,
        assignments: [assignment],
      }),
    ).toMatchObject({ assignments: [assignment] });
  });
});
