#!/usr/bin/env node

/**
 * YNAB MCP Server
 *
 * A Model Context Protocol server providing complete YNAB API coverage
 * for integration with Claude and other MCP-compatible clients.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createServer } from './server.js';
import { loadConfig } from './config/environment.js';

// Store server reference for graceful shutdown
let server: Server | null = null;

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
  process.exit(0);
}

async function main(): Promise<void> {
  // Load and validate configuration
  const config = loadConfig();

  // Create the MCP server with all tools registered
  server = createServer(config);

  // Create stdio transport for communication
  const transport = new StdioServerTransport();

  // Connect server to transport
  await server.connect(transport);

  // Log startup (to stderr to avoid interfering with stdio protocol)
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
