import { describe, expect, it } from "vitest";
import { isPublicDependencyAddress } from "../src/index.ts";

describe("dependency address policy", () => {
  it("accepts public unicast and rejects private, local, documentation and malformed addresses", () => {
    for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"]) {
      expect(isPublicDependencyAddress(address), address).toBe(true);
    }
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.0.1",
      "192.0.2.1",
      "198.51.100.1",
      "203.0.113.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
      "not-an-address",
    ]) {
      expect(isPublicDependencyAddress(address), address).toBe(false);
    }
  });
});
