/**
 * List Accounts Tool
 *
 * Returns all accounts in a budget with balances.
 *
 * Note: amounts are formatted with the budget's currency_format (moneyFormatterFor),
 * falling back to the USD style when the settings cannot be read. Raw values stay
 * in milliunits regardless of currency.
 */

import { UNTRUSTED_TEXT_NOTE } from '../untrusted-note.js';
import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/server';
import type { YnabClient } from '../../services/ynab-client.js';
import { moneyFormatterFor } from '../../utils/milliunits.js';
import { sanitizeName } from '../../utils/sanitize.js';
import { accountDetailFields, accountDetailFieldsShape } from './account-fields.js';
import { budgetId } from '../../utils/schemas.js';
import { DELTA_SUMMARY_NOTE, deltaFields, deltaOutputShape, sinceServerKnowledge, sinceServerKnowledgeJsonSchema, splitDeleted } from '../../utils/delta.js';
import { toOutputSchema } from '../output-schema.js';
import { count, money, serverKnowledge } from '../schemas/common.js';

// Input schema
const inputSchema = z.object({
  budget_id: budgetId()
    .optional()
    .describe('Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"'),
  include_closed: z
    .boolean()
    .optional()
    .describe('Whether to include closed accounts'),
  since_server_knowledge: sinceServerKnowledge(),
});

const accountSchema = z.object({
  id: z.string(),
  name: z.string(),
  balance: money(),
  cleared_balance: money(),
  uncleared_balance: money(),
  ...accountDetailFieldsShape,
});

const FULL = 'Full list only';
const DELTA = 'Delta (since_server_knowledge) only';

/** What the tool returns (#45; rules in ../output-schema.ts). One object covers the full list and the delta. */
export const listAccountsOutputSchema = z.object({
  ...deltaOutputShape,
  accounts_by_type: z.record(z.string(), z.array(accountSchema)).describe('Keyed by YNAB account type'),
  summary: z.object({
    total_accounts: count().exactOptional().describe(FULL),
    total_assets: money().exactOptional().describe(FULL),
    total_liabilities: money().exactOptional().describe(FULL),
    liability_credits: money()
      .exactOptional()
      .describe(`${FULL}: positive balances on liability accounts, when there are any`),
    net_worth: money().exactOptional().describe(FULL),
    changed_count: count().exactOptional().describe(DELTA),
    deleted_count: count().exactOptional().describe(DELTA),
    note: z.string().exactOptional().describe(DELTA),
  }),
  server_knowledge: serverKnowledge(),
});
export type ListAccountsOutput = z.output<typeof listAccountsOutputSchema>;

// Tool definition
export const listAccountsTool: Tool = {
  name: 'ynab_list_accounts',
  description: `List all accounts in a budget with their current balances.

Use when the user asks:
- "What accounts do I have?"
- "Show my account balances"
- "What's my net worth?"
- "List my bank accounts"
- "How much money do I have?"

Returns account names, types, and current/cleared/uncleared balances, plus on_budget, closed, note, last_reconciled_at, direct import status, transfer_payee_id (use it as payee_id to record a transfer), and debt details (original balance, interest rates, minimum payments, escrow) when present.
Pass since_server_knowledge (the server_knowledge of an earlier response) to get only the accounts changed since then.

Not possible through the YNAB API (do it in the YNAB app): editing, closing or reopening accounts, setting up loan accounts, and changing interest rates.

${UNTRUSTED_TEXT_NOTE}`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        maxLength: 64,
        description: 'Budget UUID, "last-used", or "default". Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
      include_closed: {
        type: 'boolean',
        description: 'Whether to include closed accounts',
      },
      since_server_knowledge: sinceServerKnowledgeJsonSchema,
    },
  },
  outputSchema: toOutputSchema(listAccountsOutputSchema),
};

// Handler function
/**
 * Handler for the ynab_list_accounts tool.
 */
export async function handleListAccounts(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<ListAccountsOutput> {
  const validated = inputSchema.parse(args);
  const budgetId = await client.resolveBudgetId(validated.budget_id);
  const money = await moneyFormatterFor(client, budgetId);
  const includeClosed = validated.include_closed ?? false;
  const cursor = validated.since_server_knowledge;

  const response =
    cursor === undefined
      ? await client.getAccounts(budgetId)
      : await client.getAccounts(budgetId, { lastKnowledgeOfServer: cursor });
  let accounts = response.data.accounts;
  let deletedIds: string[] = [];

  if (cursor !== undefined) {
    // Delta: every changed account, closed or not, so the caller sees closures.
    ({ changed: accounts, deletedIds } = splitDeleted(accounts, (a) => a.id));
  } else if (!includeClosed) {
    accounts = accounts.filter((a) => !a.closed);
  }

  // Group by account type
  const byType: Record<string, Array<z.output<typeof accountSchema>>> = {};

  for (const account of accounts) {
    const type = account.type;
    if (byType[type] === undefined) {
      byType[type] = [];
    }
    byType[type].push({
      id: account.id,
      name: sanitizeName(account.name),
      balance: money(account.balance),
      cleared_balance: money(account.cleared_balance),
      uncleared_balance: money(account.uncleared_balance),
      ...accountDetailFields(account, { includeEmptyMaps: false }, money),
    });
  }

  if (cursor !== undefined) {
    return {
      ...deltaFields(cursor, deletedIds),
      accounts_by_type: byType,
      summary: {
        changed_count: accounts.length,
        deleted_count: deletedIds.length,
        note: DELTA_SUMMARY_NOTE,
      },
      server_knowledge: response.data.server_knowledge,
    };
  }

  // Calculate totals
  const assetTypes: string[] = ['checking', 'savings', 'cash', 'otherAsset'];
  const liabilityTypes: string[] = [
    'creditCard',
    'lineOfCredit',
    'otherLiability',
    'mortgage',
    'autoLoan',
    'studentLoan',
    'personalLoan',
    'medicalDebt',
    'otherDebt',
  ];

  const totalAssets = accounts
    .filter((a) => assetTypes.includes(String(a.type)))
    .reduce((sum, a) => sum + a.balance, 0);

  // Calculate liability totals properly:
  // - Negative balances on liability accounts = actual debt
  // - Positive balances on liability accounts = credits (overpayments)
  const liabilityAccounts = accounts.filter((a) =>
    liabilityTypes.includes(String(a.type))
  );

  // Sum only negative balances as liabilities (Math.min ensures we only count debt)
  const totalLiabilities = liabilityAccounts.reduce(
    (sum, a) => sum + Math.min(0, a.balance),
    0
  );

  // Sum positive balances on liability accounts as credits
  const totalLiabilityCredits = liabilityAccounts.reduce(
    (sum, a) => sum + Math.max(0, a.balance),
    0
  );

  // Net worth = assets + liability credits - abs(liabilities)
  // Since totalLiabilities is negative (or zero), we add it
  const netWorth = totalAssets + totalLiabilityCredits + totalLiabilities;

  return {
    accounts_by_type: byType,
    summary: {
      total_accounts: accounts.length,
      total_assets: money(totalAssets),
      // Display liabilities as a positive number for readability
      total_liabilities: money(Math.abs(totalLiabilities)),
      // Show credits on liability accounts if any exist
      ...(totalLiabilityCredits > 0 && {
        liability_credits: money(totalLiabilityCredits),
      }),
      net_worth: money(netWorth),
    },
    server_knowledge: response.data.server_knowledge,
  };
}
