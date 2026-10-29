import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

interface ServerPackage {
  registryType: string;
  identifier: string;
  version?: string;
  transport: { type: string };
  environmentVariables?: Array<{ name: string; isRequired?: boolean; isSecret?: boolean }>;
}

const root = resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  mcpName: string;
};
const server = JSON.parse(readFileSync(resolve(root, 'server.json'), 'utf8')) as {
  $schema: string;
  name: string;
  version: string;
  description: string;
  packages: ServerPackage[];
};

describe('server.json manifest', () => {
  it('matches package.json version and mcpName', () => {
    expect(server.version).toBe(pkg.version);
    expect(server.name).toBe(pkg.mcpName);
  });

  it('uses the 2025-12-11 schema and a valid description length', () => {
    expect(server.$schema).toContain('/2025-12-11/');
    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it('npm package identifier and version match package.json', () => {
    const npm = server.packages.find((p) => p.registryType === 'npm');
    expect(npm).toBeDefined();
    expect(npm?.identifier).toBe(pkg.name);
    expect(npm?.version).toBe(pkg.version);
  });

  it('OCI image tag matches package.json version', () => {
    const oci = server.packages.find((p) => p.registryType === 'oci');
    expect(oci).toBeDefined();
    expect(oci?.identifier.endsWith(`:${pkg.version}`)).toBe(true);
  });

  it('Dockerfile MCP server-name label equals package.json mcpName', () => {
    const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');
    const match = /^LABEL io\.modelcontextprotocol\.server\.name="([^"]+)"/m.exec(dockerfile);
    expect(match?.[1]).toBe(pkg.mcpName);
  });

  it('every package uses stdio and declares the token as required secret', () => {
    for (const p of server.packages) {
      expect(p.transport.type).toBe('stdio');
      const token = p.environmentVariables?.find((e) => e.name === 'YNAB_ACCESS_TOKEN');
      expect(token?.isRequired).toBe(true);
      expect(token?.isSecret).toBe(true);
    }
  });
});
