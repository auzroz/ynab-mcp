/**
 * Shared schema helper tests (budget ID sentinels).
 */

import { describe, it, expect } from 'vitest';
import {
  BUDGET_ID_SENTINELS,
  budgetId,
  budgetIdSentinel,
  isBudgetIdSentinel,
} from '../../../src/utils/schemas.js';
import { tools } from '../../../src/tools/index.js';

describe('budget ID sentinels', () => {
  it('lists exactly the YNAB sentinels', () => {
    expect([...BUDGET_ID_SENTINELS]).toEqual(['last-used', 'default']);
  });

  it('budgetIdSentinel accepts both sentinels', () => {
    const schema = budgetIdSentinel();
    expect(schema.parse('last-used')).toBe('last-used');
    expect(schema.parse('default')).toBe('default');
  });

  it('budgetIdSentinel rejects other strings, including case variants', () => {
    const schema = budgetIdSentinel();
    for (const value of ['DEFAULT', 'Default', 'last_used', ' default', 'defaults', '']) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it('isBudgetIdSentinel distinguishes sentinels from budget UUIDs', () => {
    expect(isBudgetIdSentinel('last-used')).toBe(true);
    expect(isBudgetIdSentinel('default')).toBe(true);
    expect(isBudgetIdSentinel('12345678-1234-1234-1234-123456789012')).toBe(false);
    expect(isBudgetIdSentinel('DEFAULT')).toBe(false);
  });

  it('budgetId() still accepts sentinels and UUIDs and caps length at 64', () => {
    const schema = budgetId();
    expect(schema.safeParse('default').success).toBe(true);
    expect(schema.safeParse('last-used').success).toBe(true);
    expect(schema.safeParse('x'.repeat(64)).success).toBe(true);
    expect(schema.safeParse('x'.repeat(65)).success).toBe(false);
  });
});

describe('tool budget_id descriptions', () => {
  it('mention both sentinels in every tool that takes budget_id', () => {
    const withBudgetId = tools.filter((t) => {
      const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties;
      return props !== undefined && 'budget_id' in props;
    });
    expect(withBudgetId.length).toBeGreaterThan(0);

    for (const tool of withBudgetId) {
      const prop = (tool.inputSchema as { properties: Record<string, { description?: string }> })
        .properties['budget_id'];
      expect(prop?.description, tool.name).toContain('"last-used"');
      expect(prop?.description, tool.name).toContain('"default"');
    }
  });
});
