/**
 * Prompt request error mapping (end-to-end through the MCP protocol).
 *
 * Unknown prompt names and invalid arguments are client errors (InvalidParams).
 * Anything else thrown while building a prompt must surface as a generic
 * InternalError with no internal text.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

vi.mock('../../src/prompts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/prompts/index.js')>();
  return { ...actual, getPromptMessages: vi.fn(actual.getPromptMessages) };
});

import * as promptsModule from '../../src/prompts/index.js';
import { createServerForUser } from '../../src/server.js';

const baseCtx = {
  accessToken: 'test-token',
  defaultBudgetId: undefined,
  readOnly: true,
  rateLimitPerHour: 180,
  cacheTtlMs: 300000,
};

async function connectClient() {
  const server = createServerForUser(baseCtx);
  const client = new Client({ name: 'prompt-test', version: '1' }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server };
}

describe('prompts/get error mapping', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
    vi.mocked(promptsModule.getPromptMessages).mockClear();
  });

  it('maps an unknown prompt name to InvalidParams with the sanitized name', async () => {
    const { client, server } = await connectClient();
    const name = 'no-such-prompt\nwith-newline';

    const err = await client.getPrompt({ name, arguments: {} }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
    expect((err as McpError).message).toContain('Unknown prompt: no-such-promptwith-newline');
    expect((err as McpError).message).not.toContain('\n');

    await client.close();
    await server.close();
  });

  it('maps invalid arguments to a known prompt to InvalidParams', async () => {
    const { client, server } = await connectClient();

    const err = await client
      .getPrompt({ name: 'ynab-monthly-review', arguments: { month: 'not-a-month' } })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
    expect((err as McpError).message).toContain('Invalid arguments for prompt ynab-monthly-review');
    expect((err as McpError).message).not.toContain('not-a-month');

    await client.close();
    await server.close();
  });

  it('maps an unexpected builder failure to a generic InternalError', async () => {
    const { client, server } = await connectClient();
    vi.mocked(promptsModule.getPromptMessages).mockImplementationOnce(() => {
      throw new Error('secret internal detail /var/db token=abc123');
    });

    const err = await client
      .getPrompt({ name: 'ynab-pulse-check', arguments: {} })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(ErrorCode.InternalError);
    expect((err as McpError).message).toContain('Failed to build prompt');
    expect((err as McpError).message).not.toContain('secret internal detail');
    expect((err as McpError).message).not.toContain('abc123');
    // The detail is still logged server-side, sanitized.
    expect(consoleError).toHaveBeenCalledWith('[PromptError]', expect.any(String));
    const logged = String(consoleError.mock.calls.at(-1)?.[1]);
    expect(logged).not.toContain('abc123');
    expect(logged).not.toContain('/var/db');

    await client.close();
    await server.close();
  });

  it('returns the prompt for a valid request', async () => {
    const { client, server } = await connectClient();

    const result = await client.getPrompt({ name: 'ynab-monthly-review', arguments: { month: '2026-06-01' } });

    expect(result.messages).toHaveLength(1);
    expect(JSON.stringify(result.messages)).toContain('2026-06-01');

    await client.close();
    await server.close();
  });
});
