# Tier-1 WebXDC test harness

Opt-in test infra that loads each `.xdc` in headless Chromium with a stub
`webxdc.js`, pushes synthetic updates, and asserts on DOM + outbound
updates. Covers every app's auto-upgrade handshake + app-specific DOM
smoke tests. See `docs/specs/2026-04-20-e2e-testing-proposal.md` §Layer 1.

## Why it's isolated

The dispatcher runs `bun install` (not `--production`) on every
marketplace install, so a top-level `devDependency` on Playwright would
pull ~5 MB of JS onto every paired phone. To keep marketplace users at
zero cost, Playwright lives in this nested `package.json` only —
`bun install` in `plugin/` never recurses here.

Chromium itself (~200 MB) is gated by `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
in the local `.npmrc`. Contributors who want to run the harness opt in
with a separate command (below).

The default `bun test` in `plugin/` ignores this directory via
`bunfig.toml`, so CI green is preserved at 548/0.

## Contributor bootstrap

Two commands, one time:

```bash
cd plugin/test/webxdc
bun install                          # ~5 MB, Playwright JS only
bunx playwright install chromium     # ~200 MB, browser binary
```

After that, from the plugin dir:

```bash
bun run test:webxdc
```

## Prereqs at test time

`plugin/webxdc-prebuilt/*.xdc` must be up to date. Regenerate with
`bun run build:xdcs` after changing any HTML source.

## Layout

- `shim.js` — Stub `webxdc.js` (~50 LOC) injected into every loaded page.
  Captures `sendUpdate` into `window.__harness.outbound`; feeds
  `setUpdateListener` from `window.__harness.push(payload)`.
- `harness.ts` — `createHarness(xdcPath)`: unzips the `.xdc` into a tmp
  dir, serves it over an ephemeral HTTP port, launches Chromium,
  returns `{page, push, outbound, clearOutbound, getAppVersion, close}`.
- `auto-upgrade.pw.ts` — Cross-app: every `.xdc` must reply with a
  `version_mismatch` update when we push `{version: APP_VERSION + 1}`.
- `file-reviewer.pw.ts` — File-reviewer smoke: send markdown,
  long-press a paragraph, leave a comment, assert outbound update.

Files use `.pw.ts` (Playwright-test) naming so Bun's default
`bun test` doesn't try to discover or load them; Playwright's config
picks them up via `testMatch`.

## Writing a new test

```ts
// test/webxdc/my-new-test.pw.ts
import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { createHarness } from './harness.js';

const XDC = join(import.meta.dir, '..', '..', 'webxdc-prebuilt', 'file-reviewer-v1.38.xdc');

test('file-reviewer renders markdown', async () => {
  const h = await createHarness(XDC);
  try {
    await h.push({ type: 'file', title: 'x', content: '# Hi', version: 1 });
    await h.page.waitForSelector('h1');
    expect(await h.page.textContent('h1')).toBe('Hi');
  } finally {
    await h.close();
  }
});
```

Tests read version numbers from the app (`h.getAppVersion()`), not from
hardcoded constants, so they survive version bumps.
