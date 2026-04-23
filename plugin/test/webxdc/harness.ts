/**
 * Tier-1 WebXDC harness.
 *
 * Given a pre-built `.xdc` file, this module:
 *   1. unzips it into a tmp dir
 *   2. starts an ephemeral HTTP server on 127.0.0.1:<random>
 *   3. serves the unzipped contents, replacing any `webxdc.js` request
 *      with our local `shim.js`
 *   4. hands the caller a Playwright page loaded at http://127.0.0.1:<port>/
 *
 * The harness does not depend on the dispatcher or any DC RPC. It's pure
 * DOM + sandboxed JS, suitable for every-push CI.
 */

import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname, resolve as pathResolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";

export interface HarnessHandle {
  page: Page;
  push: (payload: unknown) => Promise<void>;
  outbound: () => Promise<Array<{ update: unknown; descr: string }>>;
  clearOutbound: () => Promise<void>;
  getAppVersion: () => Promise<number>;
  close: () => Promise<void>;
}

interface InternalHandle {
  browser: Browser;
  context: BrowserContext;
  server: Server;
  tmpDir: string;
}

const SHIM_PATH = join(import.meta.dir, "shim.js");

function contentTypeFor(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function unzipXdc(xdcPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dc-webxdc-harness-"));
  const r = spawnSync("unzip", ["-q", xdcPath, "-d", dir]);
  if (r.status !== 0) {
    throw new Error(`unzip failed: ${r.stderr?.toString() ?? "no stderr"}`);
  }
  return dir;
}

function startHttpServer(rootDir: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        let pathname = url.pathname === "/" ? "/index.html" : url.pathname;
        // Intercept webxdc.js: serve the shim instead.
        if (pathname === "/webxdc.js") {
          const shim = await readFile(SHIM_PATH);
          res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
          res.end(shim);
          return;
        }
        // Reject traversal. pathResolve keeps us inside rootDir.
        const absolute = pathResolve(rootDir, "." + pathname);
        if (!absolute.startsWith(rootDir)) {
          res.writeHead(403).end("forbidden");
          return;
        }
        const body = await readFile(absolute);
        res.writeHead(200, { "content-type": contentTypeFor(pathname) });
        res.end(body);
      } catch (err: any) {
        if (err && err.code === "ENOENT") {
          res.writeHead(404).end("not found");
        } else {
          res.writeHead(500).end(String(err));
        }
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("server.address() returned unexpected value"));
        return;
      }
      resolve({ server, port: addr.port });
    });
    server.on("error", reject);
  });
}

export async function createHarness(xdcPath: string): Promise<HarnessHandle> {
  const tmpDir = unzipXdc(xdcPath);
  const { server, port } = await startHttpServer(tmpDir);
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, // iPhone-ish portrait
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });

  const internal: InternalHandle = { browser, context, server, tmpDir };

  return {
    page,
    push: async (payload) => {
      await page.evaluate((p) => (window as any).__harness.push(p), payload);
    },
    outbound: async () => {
      return await page.evaluate(() => JSON.parse(JSON.stringify((window as any).__harness.outbound)));
    },
    clearOutbound: async () => {
      await page.evaluate(() => (window as any).__harness.clearOutbound());
    },
    getAppVersion: async () => {
      return await page.evaluate(() => (window as any).APP_VERSION);
    },
    close: async () => {
      await context.close();
      await browser.close();
      await new Promise<void>((r) => internal.server.close(() => r()));
      rmSync(internal.tmpDir, { recursive: true, force: true });
    },
  };
}
