import { describe, test, expect, afterEach } from 'bun:test'
import { createServer, type connect, type Server } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDispatcherListening } from '../dispatcher/dispatcher-singleton'

/**
 * The project `.mcp.json` declares the `deltachat` server (`bun … start` =
 * server.ts) — that's how the host session launches the dispatcher, so it has
 * to stay. But subagents spawn with cwd = the plugin dir and would auto-load
 * the same .mcp.json, booting a rival server.ts that blocks forever on the DC
 * account-DB lock. The fix: a duplicate server.ts detects the live dispatcher
 * socket at startup and exits fast. `isDispatcherListening` is that probe.
 */
let server: Server | null = null
afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())) ; server = null }
})

describe('isDispatcherListening', () => {
  test('false when nothing is listening on the path', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'dc-singleton-')), 'd.sock')
    expect(await isDispatcherListening(p, 500)).toBe(false)
  })

  test('true when a server is listening on the path', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'dc-singleton-')), 'd.sock')
    server = createServer()
    await new Promise<void>((res) => server!.listen(p, () => res()))
    expect(await isDispatcherListening(p, 500)).toBe(true)
  })

  // A connect that neither accepts nor errors before the timeout means the
  // socket is held by a dispatcher too busy to accept (loaded machine), not a
  // dead one. Assuming dead here lets a duplicate unlink the live socket and
  // break every permission relay mid-turn — so timeout must resolve true.
  test('true when connect hangs until timeout (busy dispatcher = assume alive)', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'dc-singleton-')), 'd.sock')
    writeFileSync(p, '') // existsSync gate needs a file at the path
    const hangingConnect = (() => ({ once() {}, destroy() {} })) as unknown as typeof connect
    expect(await isDispatcherListening(p, 100, hangingConnect)).toBe(true)
  })
})
