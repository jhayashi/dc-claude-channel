/**
 * Unit tests for chatmail-probe.ts.
 * Run without Docker — all assertions use a port known to be closed.
 */

import { describe, test, expect } from "bun:test";
import { probeChatmail, skipIfUnreachable, isTestRelay } from "./chatmail-probe.js";

const CLOSED_PORT = "localhost:19999"; // nothing listens here

describe("isTestRelay", () => {
  test("localhost is a test relay", () => {
    expect(isTestRelay("localhost")).toBe(true);
  });
  test("127.0.0.1 is a test relay", () => {
    expect(isTestRelay("127.0.0.1")).toBe(true);
  });
  test("underscore-prefix domain is a test relay", () => {
    expect(isTestRelay("_chatmail.test")).toBe(true);
  });
  test("nine.testrun.org is not a test relay", () => {
    expect(isTestRelay("nine.testrun.org")).toBe(false);
  });
});

describe("probeChatmail", () => {
  test("returns ok=false for a closed port", async () => {
    const result = await probeChatmail(CLOSED_PORT, 2_000);
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
  }, 5_000);

  test("returns ok=false with an error string", async () => {
    const result = await probeChatmail(CLOSED_PORT, 2_000);
    expect(result.error?.length).toBeGreaterThan(0);
  }, 5_000);
});

describe("skipIfUnreachable", () => {
  test("returns skip=true for an unreachable relay", async () => {
    const result = await skipIfUnreachable(CLOSED_PORT);
    expect(result.skip).toBe(true);
    if (result.skip) {
      expect(result.reason).toContain(CLOSED_PORT);
      expect(result.reason).toContain("podman-run.sh");
    }
  }, 5_000);

  test("reason includes the target relay host", async () => {
    const result = await skipIfUnreachable(CLOSED_PORT);
    expect(result.skip).toBe(true);
    if (result.skip) {
      expect(result.reason).toContain("localhost");
    }
  }, 5_000);
});
