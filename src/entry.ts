/**
 * Process entry: transport resolution, process-level handlers and shutdown.
 * src/index.ts only calls `main()`, so everything here can be tested without
 * running the server.
 */

import type { Server as HttpServer } from 'node:http';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { createStdioServerFactory } from './server.js';
import { redactSecretEnvValues } from './utils/sanitize.js';
import { startHttpServer } from './http.js';
import { loadConfig, loadHttpConfig } from './config/environment.js';
import { LOOPBACK_HOSTNAMES, type Env } from './config/parse.js';
import type { HttpConfig } from './config/environment.js';

export type Transport = 'stdio' | 'http';

/** How long shutdown may take before the process exits anyway (docker stop waits 10 s before SIGKILL). */
export const SHUTDOWN_DEADLINE_MS = 10_000;

/**
 * `MCP_TRANSPORT`: `stdio` (the default when unset or empty) or `http`.
 * Anything else is refused: a typo must not start a different server than the
 * operator asked for. The message does not repeat the value.
 */
export function resolveTransport(env: Env = process.env): Transport {
  const raw = env['MCP_TRANSPORT'];
  if (raw === undefined || raw.trim() === '') return 'stdio';
  const v = raw.trim().toLowerCase();
  if (v === 'stdio' || v === 'http') return v;
  throw new Error('Invalid MCP_TRANSPORT. Expected: stdio or http.');
}

/**
 * An error's message for the operator's stderr: only the message (never the
 * whole error object), with the values of secret env vars removed. Config
 * errors are value-free already; this also covers errors from libraries.
 */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return redactSecretEnvValues(message);
}

export interface ShutdownDeps {
  /** Closes whatever is running; may reject. */
  close: () => Promise<void>;
  exit: (code: number) => void;
  deadlineMs?: number;
  log?: (message: string) => void;
}

/**
 * Run `close`, then exit 0; exit 1 if it hasn't finished within the deadline
 * (a stuck connection or job must not keep the process alive past the
 * platform's own kill). A close that throws is logged and the exit is still 0.
 */
export async function shutdownWithDeadline(deps: ShutdownDeps): Promise<void> {
  const log = deps.log ?? ((m: string) => console.error(m));
  const deadlineMs = deps.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  log('Shutting down YNAB MCP Server...');
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), deadlineMs);
    timer.unref();
  });
  const closed = deps.close().then(
    () => 'closed' as const,
    (error: unknown) => {
      // Only the message, with secret env values removed.
      log(`[DEBUG] Error during shutdown: ${errorMessage(error)}`);
      return 'closed' as const;
    }
  );
  const outcome = await Promise.race([closed, deadline]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome === 'timeout') {
    log(`Shutdown did not finish within ${deadlineMs} ms; exiting.`);
    deps.exit(1);
    return;
  }
  deps.exit(0);
}

/**
 * Operator warnings about proxy trust (#59), shown at HTTP startup. With
 * TRUST_PROXY=0 and a public (non-loopback) PUBLIC_URL the server is probably
 * behind a proxy, so every client shares the proxy's address and one
 * rate-limit bucket. Fixed text: it repeats no value from the environment.
 * Not shown when TRUST_CF_CONNECTING_IP is on, which names the client address
 * another way.
 */
export function proxyWarnings(
  config: Pick<HttpConfig, 'publicUrl' | 'trustProxy' | 'trustCfConnectingIp'>
): string[] {
  if (!config.publicUrl || config.trustProxy !== 0 || config.trustCfConnectingIp) return [];
  let hostname: string;
  try {
    hostname = new URL(config.publicUrl).hostname;
  } catch {
    return [];
  }
  // URL keeps the brackets of an IPv6 host; LOOPBACK_HOSTNAMES lists '[::1]'.
  if (LOOPBACK_HOSTNAMES.has(hostname)) return [];
  return [
    'TRUST_PROXY=0 with a non-localhost PUBLIC_URL: if this server is behind a reverse proxy, ' +
      "every client shares the proxy's address, so one client can exhaust the OAuth rate limits for all. " +
      'Set TRUST_PROXY to the number of proxy hops (see docs/REMOTE_HOSTING.md, "Client addresses and rate limits"), ' +
      'or leave it at 0 if clients connect to this server directly.',
  ];
}

// What shutdown closes, set as each transport starts.
let stdioHandle: StdioServerHandle | null = null;
let httpServer: HttpServer | null = null;

async function closeAll(): Promise<void> {
  if (stdioHandle) await stdioHandle.close();
  if (httpServer) {
    const http = httpServer;
    // HttpServer.close (see startHttpServer) also stops the sessions and the extension jobs before calling back.
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
}

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  void shutdownWithDeadline({ close: closeAll, exit: (code) => process.exit(code) });
}

/** Handlers for every transport; the stdin listener is stdio's alone (see main). */
function installProcessHandlers(): void {
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // An unhandled rejection leaves the server in an unknown state: log it (message only) and stop.
  process.on('unhandledRejection', (reason: unknown) => {
    console.error('Unhandled rejection:', errorMessage(reason));
    process.exit(1);
  });
}

export async function main(env: Env = process.env): Promise<void> {
  const transport = resolveTransport(env);
  installProcessHandlers();

  if (transport === 'http') {
    // A stdin that closes (a detached container, a service manager) says nothing about an HTTP server.
    const httpConfig = loadHttpConfig(env);
    for (const warning of proxyWarnings(httpConfig)) console.error(`Warning: ${warning}`);
    httpServer = await startHttpServer(httpConfig);
    return;
  }

  // stdio (single-user) mode: the client closing stdin ends the session.
  process.stdin.on('close', shutdown);
  const config = loadConfig();
  stdioHandle = serveStdio(createStdioServerFactory(config), {
    onerror: (error) => console.error('MCP stdio error:', errorMessage(error)),
  });
  console.error(`YNAB MCP Server started (budget: ${config.defaultBudgetId ?? 'last-used'})`);
}

/** Run `main` as the process entry: a startup failure is logged (message only) and exits 1. */
export function runEntry(): void {
  main().catch((error: unknown) => {
    console.error('Failed to start YNAB MCP Server:', errorMessage(error));
    process.exit(1);
  });
}
