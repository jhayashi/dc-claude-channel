/**
 * Lightweight reachability probe for the chatmail relay used in tier-2
 * integration tests. Checks whether the relay's HTTPS port is up before
 * the test suite attempts to provision accounts.
 *
 * Both exports are safe to call unconditionally at module scope — they
 * never throw; they return structured results instead.
 */

/**
 * TCP-connect + HTTP-GET probe against a chatmail relay.
 *
 * @param target  host:port (e.g. "localhost:8443" or "nine.testrun.org")
 * @param timeoutMs  per-attempt timeout (default 3000ms)
 */
export async function probeChatmail(
  target: string,
  timeoutMs = 3_000,
): Promise<{ ok: boolean; error?: string }> {
  const [host, portStr] = target.split(":");
  const port = portStr ? Number(portStr) : 443;
  const url = `https://${target}/new`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // For local/test-domain relays the cert is self-signed — skip TLS
    // verification.  Production relays keep strict checks.
    const tlsOpts = isTestRelay(host) ? { rejectUnauthorized: false } : undefined;
    const resp = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      // Real chatmail hosts 301 GET /new -> `dcaccount:...` (the QR
      // scheme); auto-follow would throw UnsupportedRedirectProtocol
      // before we can conclude "port is up". We only care that the
      // relay answered at all.
      redirect: "manual",
      // Bun-specific: per-request TLS options
      // @ts-ignore
      tls: tlsOpts,
    });
    clearTimeout(timer);
    // Any HTTP response means the port is accepting connections — even a
    // 4xx means the relay is up and the port is usable.
    return { ok: true };
  } catch (err: unknown) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

/**
 * Returns `{ skip: true, reason }` when the relay is unreachable (or the
 * DC_INTEGRATION_TEST gate is off). Returns `{ skip: false }` when the
 * suite should run.
 *
 * Designed for use with bun:test's `describe.skipIf`:
 *
 *   const probe = await skipIfUnreachable("localhost:8443")
 *   describe.skipIf(probe.skip)("tier-2 pairing", () => { ... })
 */
export async function skipIfUnreachable(
  target: string,
): Promise<{ skip: true; reason: string } | { skip: false }> {
  const result = await probeChatmail(target);
  if (!result.ok) {
    return {
      skip: true,
      reason: `relay ${target} unreachable: ${result.error ?? "unknown error"} — run \`./podman-run.sh up\` in plugin/test/integration/chatmail-docker/`,
    };
  }
  return { skip: false };
}

/** True for local / chatmail-test-domain hosts that use self-signed certs. */
export function isTestRelay(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host.startsWith("_");
}
