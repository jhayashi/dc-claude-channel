# 0.8 release plan — marketplace distribution

Tracks GitHub issue #8.

## Key insight

The Rust binary problem is **already solved by npm optional dependencies**.
`@deltachat/stdio-rpc-server` pulls the right per-platform binary subpackage
(`@deltachat/stdio-rpc-server-linux-x64`, `-darwin-arm64`, etc.) automatically
on `bun install`. And `plugin/.mcp.json` already runs `bun install && bun
server.ts` as its startup command, so it should work from a marketplace-copied
plugin cache directory with no lazy downloads or platform binaries to ship.
This dramatically simplifies the plan.

## Goal

A user can run:

    /plugin marketplace add jhayashi/dc-claude-channel
    /plugin install deltachat@dc-claude-channel

and get a working Delta Chat channel, with no manual `install.sh` required.
Tagged as `v0.8.0` on GitHub.

## Phase 1 — Verify the copy-to-cache path actually works (30 min, no commits)

Before changing anything, **prove the happy path works as-is**. Today's
`.mcp.json` already runs `bun install && bun server.ts`, which should cover
the cold-cache case.

1. Copy `plugin/` to a scratch directory:

        cp -r plugin /tmp/fake-plugin-cache
        rm -rf /tmp/fake-plugin-cache/node_modules

2. Set `CLAUDE_PLUGIN_ROOT=/tmp/fake-plugin-cache` in the shell.
3. Run `bun run --cwd $CLAUDE_PLUGIN_ROOT --silent start` manually and make
   sure it starts the MCP server successfully.
4. Time how long the first `bun install` takes on a fresh cache. Under ~15s
   is fine. 60s+ needs mitigation.

**Exit criteria:** server starts cold from a `node_modules`-free copy and
responds to a basic MCP ping.

**Risks to catch here:**

- `${CLAUDE_PLUGIN_ROOT}` env var substitution — is it actually set by Claude
  Code for MCP commands, or only for hooks? If only for hooks, the current
  `.mcp.json` is broken and needs a different invocation.
- `bun install` writing into a read-only cache dir (shouldn't happen for
  normal installs; would for seeded containers — ignore for 0.8).
- The state dir (`~/.claude/channels/deltachat/`) needs to be created on
  first run — verify it is.
- `deltachat-rpc-server` binary gets pulled into the right path and spawned
  correctly.

## Phase 2 — Create the marketplace catalog (10 min, one commit)

**New file:** `.claude-plugin/marketplace.json` at the repo root:

    {
      "name": "dc-claude-channel",
      "owner": { "name": "Joe Hayashi" },
      "metadata": {
        "description": "Delta Chat channel for Claude Code — encrypted messaging bridge with WebXDC apps and access control"
      },
      "plugins": [
        {
          "name": "deltachat",
          "source": "./plugin",
          "description": "Delta Chat channel with WebXDC file reviewer, permission relay, and onboarding tutorial",
          "version": "0.8.0",
          "author": { "name": "Joe Hayashi" },
          "homepage": "https://github.com/jhayashi/dc-claude-channel",
          "repository": "https://github.com/jhayashi/dc-claude-channel",
          "license": "MIT",
          "keywords": ["deltachat", "messaging", "channel", "mcp", "webxdc", "encrypted"]
        }
      ]
    }

**Edit:** bump `plugin/.claude-plugin/plugin.json` from `0.1.0` to `0.8.0`.
(Per the docs: version in plugin.json is authoritative for non-relative-path
sources; for relative-path sources, the marketplace entry wins. Setting both
to `0.8.0` is safe.)

**Note:** keep the marketplace `name` matching the repo name so users can
do `/plugin marketplace add jhayashi/dc-claude-channel` without surprises.

## Phase 3 — Local-path install smoke test (20 min, no commits)

From a directory **outside** the repo (critical — running Claude Code from
inside the repo will double-register via `plugin/.mcp.json` as a project-level
MCP server):

    cd ~/some-unrelated-project
    claude --dangerously-load-development-channels plugin:deltachat@dc-claude-channel

Before launching, do these in an existing session:

    /plugin marketplace add /var/home/jhayashi/src/dc-claude-channel
    /plugin install deltachat@dc-claude-channel

Verify:

- `/mcp` shows exactly one server: `plugin:deltachat:deltachat`
- No duplicate plain `deltachat` entry from a project-level `.mcp.json`
- `/deltachat:configure` works and reports bot status
- `/deltachat:configure invite` returns an invite link
- Can pair a fresh Delta Chat contact
- Tutorial fires after pairing
- File reviewer and permission apps deliver correctly

**Exit criteria:** full pairing + tutorial flow works from a
marketplace-cloned cache copy.

## Phase 4 — End-to-end test via real git clone (30 min, one commit cycle)

This exercises the realistic install path (clone from GitHub, not local copy)
to catch anything that depends on state outside the repo.

1. Push the marketplace.json commit from Phase 2.
2. From a throwaway scratch dir, simulate a fresh user:

        /plugin marketplace remove dc-claude-channel
        /plugin marketplace add jhayashi/dc-claude-channel
        /plugin install deltachat@dc-claude-channel

3. Re-run the Phase 3 verification checklist.

**What this catches that Phase 3 doesn't:**

- Missing committed artifacts (WebXDC HTML not committed, `.gitignore`
  excluding something essential)
- Paths that only work relative to the dev clone
- `node_modules/` references bleeding in via working tree

## Phase 5 — README update (15 min, one commit)

**Section to add at the top of the install docs:**

    ## Install

    Requires Claude Code v2.1.80+ and `bun` on your PATH.

        /plugin marketplace add jhayashi/dc-claude-channel
        /plugin install deltachat@dc-claude-channel

    Then launch Claude Code with:

        claude --dangerously-load-development-channels plugin:deltachat@dc-claude-channel

    (The `--dangerously-load-development-channels` flag is required during
    the Claude Code channels research preview. It can be removed once the
    plugin is added to the official allowlist.)

**Section to demote:** move the existing `install.sh` instructions to a
"Develop from source" section at the bottom. Explain it's for contributors
hacking on the plugin itself, not end users.

**Section to update:** prerequisites list. Can remove the
`pipx install deltachat-rpc-server` line entirely since `bun install` handles
it automatically via optional deps. Keep `bun` as a prereq.

## Phase 6 — Tag and release (10 min)

    git tag -a v0.8.0 -m "v0.8.0 — marketplace distribution"
    git push origin v0.8.0
    gh release create v0.8.0 --title "v0.8.0 — marketplace distribution" --notes-file RELEASE_NOTES.md

**Release notes outline:**

- What's new: `/plugin install` flow, no more `install.sh` required
- Prereqs: Claude Code v2.1.80+, `bun`, chatmail invite (or BYO chatmail)
- Known limitations: requires `--dangerously-load-development-channels`
  until Anthropic allowlist review
- Feature highlights (condensed from README)
- Credits

## Phase 7 — Anthropic allowlist submission (target: 0.9)

The `--dangerously-load-development-channels` flag is load-bearing during
the research preview: without it, users can only install our plugin if
their org admin explicitly allowlists it or Anthropic adds it to the
official marketplace. Neither is realistic for a broad rollout, so
submission is the single biggest unblocker between 0.8 and general
availability.

### Why we wait for 0.9, not submit at 0.8

Anthropic's plugin marketplace review is Anthropic-curated and covers
**security review** for channels specifically
(https://code.claude.com/docs/en/plugins#submit-your-plugin-to-the-official-marketplace).
Channels have broad authority — they inject text into Claude's context,
can relay permission approvals, and run as a subprocess with full user
privileges — so the bar is meaningfully higher than regular plugins.

We should not submit until the following are true:

1. **The codebase has been exercised by ≥3 real users** across the 0.8
   release to shake out runtime bugs. Submitting a plugin with a known
   crash path is a bad look and slows down subsequent reviews.
2. **The access control story is documented** in SECURITY.md with:
   - Threat model (who can reach the bot, what can they do)
   - Owner verification protocol for WebXDC updates (already implemented)
   - Pairing flow and how the allowlist prevents unknown contacts from
     reaching Claude
   - What state lives where (`~/.claude/channels/deltachat/`)
3. **No pending high-severity issues** on the GitHub tracker at time of
   submission.
4. **Bundled or reproducible build** — if Phase 1 finds that `bun install`
   at cache-copy time is slow or fragile, we want the `bun build
   --compile` single-file executable in place before Anthropic looks at
   the supply chain. A reviewer opening `node_modules` full of transitive
   deps is a harder audit than a reviewer opening a single compiled
   binary + a lockfile.

### Submission prerequisites checklist

Before opening the submission issue on `anthropics/claude-plugins-official`:

- [ ] 0.8.0 tagged and released on GitHub
- [ ] ≥3 users have installed via marketplace and completed pairing
- [ ] Tutorial flow testing (issue #2) completed on Android, iOS, Desktop
- [ ] `SECURITY.md` written and in the repo root
- [ ] Threat model section in README or SECURITY.md
- [ ] All P0/P1 GitHub issues closed
- [ ] Bundled server (0.9 work) landed
- [ ] Version-bump CI check (0.9 work) landed — reviewers will check
      update cadence
- [ ] `license` field in plugin.json and marketplace.json matches actual
      LICENSE file
- [ ] `repository` URL points at the canonical GitHub repo
- [ ] Consistent author / owner / homepage metadata across
      marketplace.json, plugin.json, package.json, README
- [ ] README clearly warns about `--dangerously-load-development-channels`
      requirement today and explains what goes away after approval

### How to submit

Per the docs, the submission path is: open a PR or issue against
`anthropics/claude-plugins-official` requesting the plugin be added to the
`external_plugins/` directory of that repo. The submission includes:

- Link to this repo's marketplace.json
- Description of what the channel does and why it's useful
- Security review document (SECURITY.md)
- Link to test matrix and recent test results
- Contact info for review follow-ups

Anthropic runs a security review and either approves, requests changes,
or declines. There is **no published SLA** — the research preview makes
no promise about how long review takes. Plan accordingly: submit early
in the 0.9 cycle so any review-driven changes can land in 0.9.x patches
rather than blocking 1.0.

### Interim workaround for early users

While waiting for allowlist approval, users on Team or Enterprise plans
can unblock themselves without the dev flag by adding the plugin to
their org's `allowedChannelPlugins` in managed settings. This is a
per-org config change and requires admin access. For individual users,
the dev flag is the only option.

Both should be documented in the README's install section as an
"Advanced" note.

### Post-approval work

Once approved:

1. The `--dangerously-load-development-channels` flag is no longer
   required. Drop it from the README install instructions.
2. Bump to 1.0.0 to mark the first generally-available release.
3. Add a release channels split (stable vs latest) so users can opt in
   to pre-release builds without affecting production users.
4. Announce on the Delta Chat forum, r/DeltaChat, and Claude Code
   GitHub Discussions.

## Phase 8 — Deferred beyond the 0.8 → 0.9 → 1.0 sequence

Explicitly out of scope for the next three releases, with rationale:

| Item | Defer to | Why |
|---|---|---|
| Version-bump CI check | 0.9 | Manual version bumps are fine while velocity is low |
| Bundled `server.ts` via `bun build --compile` | 0.9 | Only needed if Phase 1 finds first-run `bun install` latency is bad; also required before allowlist submission |
| Anthropic allowlist submission | 0.9 | See Phase 7 above for full details |
| SECURITY.md and threat model doc | 0.9 | Prereq for submission |
| Release to 1.0 / general availability | After allowlist approval | Gated on Anthropic review completing |
| Stable/latest release channels | 1.0 | Unnecessary with few users |
| Seed directory support for containers | 1.0+ | Niche |
| npm-package plugin source | 1.0+ | git-subdir or local-path is sufficient for now |

## Risks summary

1. **`bun install` doesn't run in cache dir** — if `${CLAUDE_PLUGIN_ROOT}`
   env var isn't substituted for MCP commands, the current `.mcp.json` fails
   silently. Phase 1 catches this early. If it fails, the fallback is to
   commit a pre-bundled `dist/server.js` and change the MCP command to
   `bun run dist/server.js`.
2. **First-run latency** — if `bun install` takes 30s+ on fresh caches,
   users will think the plugin is broken. Mitigation: add a startup print
   to stderr saying "installing dependencies on first run, please wait" so
   the delay is visible in the debug log.
3. **Two-repo test matrix** — Phase 4 requires testing against a real
   GitHub clone. Don't skip it.
4. **Double-registration via `plugin/.mcp.json`** — if anyone runs Claude
   Code from within the repo, the project-level MCP server conflicts with
   the plugin-installed one. The CLAUDE.md already warns about this.
   Consider moving `.mcp.json` into a `dev/` subdirectory to eliminate the
   risk entirely, or just document it.
5. **Symbolic-link leftovers** — the `markdown-viewer.*` symlinks were
   already removed. Make sure there's no stale state in the working tree
   before tagging.

## Files touched

- **New:** `.claude-plugin/marketplace.json`, `RELEASE_NOTES.md`
- **Modified:** `plugin/.claude-plugin/plugin.json` (version), `README.md`
- **Not touched (important):** `plugin/server.ts`, `plugin/.mcp.json` —
  the runtime is intentionally unchanged for 0.8

## Estimated total time

~2-3 hours of focused work, spread across 4-5 commits:

1. marketplace.json + plugin.json version bump
2. README rewrite
3. (possible) mitigations from Phase 1 findings
4. RELEASE_NOTES.md + tag

---

**Go/no-go gate:** Phase 1 decides everything. If `bun install`-at-startup
works from the cache dir, the rest is mechanical. If not, we need a bundling
detour that could push this to 0.9.
