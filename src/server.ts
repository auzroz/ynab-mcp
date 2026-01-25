/**
 * MCP Server Configuration and Tool Registration
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Config } from './config/environment.js';
import { YnabClient } from './services/ynab-client.js';
import { RateLimiter } from './services/rate-limiter.js';
import { Cache } from './services/cache.js';
import { tools, handleToolCall } from './tools/index.js';
import { formatErrorResponse } from './utils/errors.js';

export function createServer(config: Config): Server {
  // Initialize services
  const rateLimiter = new RateLimiter(config.rateLimitPerHour);
  const cache = new Cache(config.cacheTtlMs);
  const ynabClient = new YnabClient(
    config.accessToken,
    config.defaultBudgetId,
    rateLimiter,
    cache,
    config.readOnly
  );

  // Log read-only mode status
  if (config.readOnly) {
    console.error('YNAB MCP Server running in READ-ONLY mode (write operations disabled)');
  } else {
    console.error('YNAB MCP Server running with WRITE operations ENABLED');
  }

  // Create MCP server
  const server = new Server(
    {
      name: 'ynab-mcp-server',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tool listing handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
  });

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await handleToolCall(name, args ?? {}, ynabClient);
      return {
        content: [
          {
            type: 'text',
            text: result,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: formatErrorResponse(error),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}
