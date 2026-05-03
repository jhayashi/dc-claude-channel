import { describe, test, expect } from "bun:test";
import { bundleFor, hasCapability } from "../access/capability-bundles.js";

describe("capability bundles — bundleFor", () => {
  test("subscriber gets the wildcard bundle", () => {
    expect(bundleFor("subscriber")).toEqual(["*"]);
  });

  test("trusted-agent gets the wildcard bundle", () => {
    expect(bundleFor("trusted-agent")).toEqual(["*"]);
  });

  test("family-member gets chat + low_stakes glob", () => {
    expect(bundleFor("family-member")).toEqual(["chat", "low_stakes_*"]);
  });

  test("untrusted-agent is chat-only", () => {
    expect(bundleFor("untrusted-agent")).toEqual(["chat"]);
  });

  test("guest is chat-only", () => {
    expect(bundleFor("guest")).toEqual(["chat"]);
  });

  test("no-permissions returns the empty bundle (denied everywhere)", () => {
    expect(bundleFor("no-permissions")).toEqual([]);
  });

  test("hasCapability denies everything for the no-permissions bundle", () => {
    const bundle = bundleFor("no-permissions");
    for (const cap of ["chat", "private_data_read", "real_world_action", "infrastructure"]) {
      expect(hasCapability(bundle, cap)).toBe(false);
    }
  });

  test("unknown role returns guest bundle (fail-safe)", () => {
    expect(bundleFor("nonsense")).toEqual(["chat"]);
  });

  test("empty string role returns guest bundle", () => {
    expect(bundleFor("")).toEqual(["chat"]);
  });
});

describe("capability bundles — hasCapability", () => {
  test("matches exactly", () => {
    expect(hasCapability(["chat"], "chat")).toBe(true);
    expect(hasCapability(["chat"], "private_data_read")).toBe(false);
  });

  test("wildcard matches anything", () => {
    expect(hasCapability(["*"], "private_data_read")).toBe(true);
    expect(hasCapability(["*"], "anything")).toBe(true);
    expect(hasCapability(["*"], "")).toBe(true);
  });

  test("glob suffix matches namespace prefix", () => {
    expect(hasCapability(["low_stakes_*"], "low_stakes_chat")).toBe(true);
    expect(hasCapability(["low_stakes_*"], "low_stakes_email")).toBe(true);
    expect(hasCapability(["low_stakes_*"], "private_data_read")).toBe(false);
  });

  test("glob suffix does not match the bare prefix", () => {
    // "low_stakes_*" should not match "low_stakes" — only "low_stakes_<something>"
    expect(hasCapability(["low_stakes_*"], "low_stakes")).toBe(false);
  });

  test("empty set always denies", () => {
    expect(hasCapability([], "chat")).toBe(false);
    expect(hasCapability([], "*")).toBe(false);
  });

  test("multiple entries — any match wins", () => {
    expect(hasCapability(["chat", "low_stakes_*"], "chat")).toBe(true);
    expect(hasCapability(["chat", "low_stakes_*"], "low_stakes_email")).toBe(true);
    expect(hasCapability(["chat", "low_stakes_*"], "private_data_read")).toBe(false);
  });
});
