#!/usr/bin/env node

/**
 * YNAB MCP Server
 *
 * A Model Context Protocol server providing comprehensive YNAB API coverage
 * for integration with Claude and other MCP-compatible clients.
 */

import type { Server as HttpServer } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createServer } from './server.js';
import { startHttpServer } from './http.js';
import { loadConfig, loadHttpConfig } from './config/environment.js';

// Store server reference for graceful shutdown
let server: Server | null = null;
let httpServer: HttpServer | null = null;

async function shutdown(): Promise<void> {
  console.error('Shutting down YNAB MCP Server...');
  if (server) {
    try {
      await server.close();
    } catch (error) {
      // Log close errors at debug level (to stderr), then continue shutdown
      // Only log message to avoid leaking sensitive details from full error object
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[DEBUG] Error during server close:', message);
    }
  }
  if (httpServer) {
    try {
      await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[DEBUG] Error during HTTP server close:', message);
    }
  }
  process.exit(0);
}

async function main(): Promise<void> {
  // Transport selection: `http` for the remote/multi-user server, otherwise stdio.
  const transportMode = (process.env['MCP_TRANSPORT'] ?? 'stdio').toLowerCase();

  if (transportMode === 'http') {
    httpServer = await startHttpServer(loadHttpConfig());
    return;
  }

  // stdio (single-user) mode.
  const config = loadConfig();
  server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`YNAB MCP Server started (budget: ${config.defaultBudgetId ?? 'last-used'})`);
}

// Handle graceful shutdown
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.stdin.on('close', () => void shutdown());

// Run the server
main().catch((error: unknown) => {
  // Only log error message to avoid leaking sensitive config details
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error('Failed to start YNAB MCP Server:', message);
  process.exit(1);
});
