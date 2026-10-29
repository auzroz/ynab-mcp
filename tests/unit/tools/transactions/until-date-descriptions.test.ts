/**
 * until_date description tests: must not advertise period names as an end bound,
 * because parseNaturalDate resolves them to the START of the period.
 */

import { describe, it, expect } from 'vitest';
import { listTransactionsTool } from '../../../../src/tools/transactions/list-transactions.js';
import { listAccountTransactionsTool } from '../../../../src/tools/transactions/list-account-transactions.js';
import { listCategoryTransactionsTool } from '../../../../src/tools/transactions/list-category-transactions.js';
import { listPayeeTransactionsTool } from '../../../../src/tools/transactions/list-payee-transactions.js';

const tools = [
  listTransactionsTool,
  listAccountTransactionsTool,
  listCategoryTransactionsTool,
  listPayeeTransactionsTool,
];

describe('until_date input schema description', () => {
  it.each(tools.map((t) => [t.name, t] as const))(
    '%s warns period names resolve to period start',
    (_name, tool) => {
      const props = (
        tool.inputSchema as { properties: Record<string, { description: string }> }
      ).properties;
      const desc = props.until_date?.description ?? '';
      expect(desc).toContain('YYYY-MM-DD');
      expect(desc).toContain('"yesterday"');
      expect(desc).toContain('START of that period');
      expect(desc).not.toMatch(/natural language like "last month"/);
    }
  );
});
