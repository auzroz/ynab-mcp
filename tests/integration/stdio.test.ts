/**
 * G3: the real stdio server, spawned through tsx (no build step), driven by the
 * v2 MCP client once per protocol era. A dummy token is used and no tool that
 * calls YNAB is invoked, so nothing leaves the machine.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { UNTRUSTED_TEXT_NOTE } from '../../src/tools/untrusted-note.js';
import { SERVER_DESCRIPTION } from '../../src/server.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };
const entry = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const tsxCli = require.resolve('tsx/cli');

const READ_ONLY_TOOLS = 51;
const ALL_TOOLS = 69;

type Era = '2025-11-25' | '2026-07-28';

async function connect(era: Era, readOnly: boolean): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, entry],
    env: {
      PATH: process.env['PATH'] ?? '',
      YNAB_ACCESS_TOKEN: 'dummy-token-for-tests',
      YNAB_READ_ONLY: readOnly ? 'true' : 'false',
    },
    stderr: 'ignore',
  });
  const client = new Client(
    { name: 'stdio-test', version: '0.0.0' },
    era === '2026-07-28' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}
  );
  await client.connect(transport);
  return { client, close: () => client.close() };
}

describe.each<Era>(['2025-11-25', '2026-07-28'])('stdio server, %s', (era) => {
  it('initializes with serverInfo and the untrusted-text instructions', async () => {
    const { client, close } = await connect(era, true);
    try {
      expect(client.getServerVersion()).toMatchObject({ name: 'ynab-mcp', version: pkg.version });
      expect(client.getInstructions()).toBe(UNTRUSTED_TEXT_NOTE);
      const caps = client.getServerCapabilities();
      expect(caps?.tools).toEqual({});
      expect(caps?.prompts).toEqual({});
    } finally {
      await close();
    }
  }, 30000);

  it('lists the read-only tools by default and calls a tool that makes no YNAB request', async () => {
    const { client, close } = await connect(era, true);
    try {
      const list = await client.listTools();
      expect(list.tools).toHaveLength(READ_ONLY_TOOLS);
      expect(list.tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);

      const result = await client.callTool({ name: 'ynab_rate_limit_status', arguments: {} });
      expect(result.isError).not.toBe(true);
      const first = (result.content as Array<{ type: string; text?: string }>)[0];
      expect(first?.type).toBe('text');
      expect(() => JSON.parse(first?.text ?? '')).not.toThrow();
    } finally {
      await close();
    }
  }, 30000);

  it('lists every tool with YNAB_READ_ONLY=false', async () => {
    const { client, close } = await connect(era, false);
    try {
      expect((await client.listTools()).tools).toHaveLength(ALL_TOOLS);
    } finally {
      await close();
    }
  }, 30000);
});

describe('stdio server, 2026-07-28 only', () => {
  it('marks tools/list private and describes the server', async () => {
    const { client, close } = await connect('2026-07-28', true);
    try {
      const list = (await client.listTools()) as { ttlMs?: number; cacheScope?: string };
      expect(list.cacheScope).toBe('private');
      expect(list.ttlMs).toBe(0);
      expect(client.getServerVersion()?.description).toBe(SERVER_DESCRIPTION);
    } finally {
      await close();
    }
  }, 30000);
});
