// Test-runtime safety net.
//
// Module-level state in plugin/access/contacts.ts defaults `_agentsDir` and
// `_principalsDir` to the production state directory. Tests that forget to
// call setContactsAgentsDir / setPrincipalsDir would silently write to prod
// (this happened during slice7-p3 development; cleanup at:
// 2026-05-02). Setting DC_TEST_* env vars before any access module is loaded
// shifts the default to a per-process tmp dir, so tests that forget still
// land in tmp instead of corrupting prod.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "dc-test-preload-"));
process.env.DC_TEST_CONTACTS_DIR = join(root, "agents");
process.env.DC_TEST_PRINCIPALS_DIR = join(root, "principals");
