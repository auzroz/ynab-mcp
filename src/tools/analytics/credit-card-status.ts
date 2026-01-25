/**
 * Credit Card Status Tool
 *
 * Shows credit card account status and payment category balances.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import * as ynab from 'ynab';
import type { YnabClient } from '../../services/ynab-client.js';
import { formatCurrency, sumMilliunits } from '../../utils/milliunits.js';
import { getCurrentMonth } from '../../utils/dates.js';
import { sanitizeName } from '../../utils/sanitize.js';

// Input schema
const inputSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe('Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"'),
});

// Tool definition
export const creditCardStatusTool: Tool = {
  name: 'ynab_credit_card_status',
  description: `Check credit card balances and payment category status.

Use when the user asks:
- "What's my credit card balance?"
- "How much do I owe on credit cards?"
- "Credit card payment status"
- "Do I have enough to pay my credit cards?"
- "Show credit card accounts"

Returns credit card balances with corresponding payment category balances.`,
  inputSchema: {
    type: 'object',
    properties: {
      budget_id: {
        type: 'string',
        description: 'Budget UUID. Defaults to YNAB_BUDGET_ID env var or "last-used"',
      },
    },
    required: [],
  },
};

interface CreditCardInfo {
  account_name: string;
  balance: number;
  cleared_balance: number;
  uncleared_balance: number;
  payment_category_balance: number;
  payment_shortfall: number;
  status: 'covered' | 'partial' | 'underfunded';
}

// Handler function
export async function handleCreditCardStatus(
  args: Record<string, unknown>,
  client: YnabClient
): Promise<string> {
  const validated = inputSchema.parse(args);
  const budgetId = client.resolveBudgetId(validated.budget_id);
  const currentMonth = getCurrentMonth();

  // Get accounts, categories, and month data
  const [accountsResponse, categoriesResponse, monthResponse] = await Promise.all([
    client.getAccounts(budgetId),
    client.getCategories(budgetId),
    client.getBudgetMonth(budgetId, currentMonth),
  ]);

  // Find credit card accounts
  const creditCards = accountsResponse.data.accounts.filter(
    (a) => a.type === ynab.AccountType.CreditCard && !a.deleted && !a.closed
  );

  if (creditCards.length === 0) {
    return JSON.stringify(
      {
        status: 'no_credit_cards',
        message: 'No active credit card accounts found',
        credit_cards: [],
      },
      null,
      2
    );
  }

  // Find Credit Card Payments category group
  const ccPaymentGroup = categoriesResponse.data.category_groups.find(
    (g) => g.name === 'Credit Card Payments'
  );

  // Build payment category lookup by name (YNAB names them after accounts)
  const paymentCategoryLookup = new Map<string, { id: string; balance: number }>();

  if (ccPaymentGroup) {
    for (const cat of ccPaymentGroup.categories) {
      paymentCategoryLookup.set(cat.name, {
        id: cat.id,
        balance: cat.balance,
      });
    }
  }

  // Also get balances from month data for current month values
  const monthCategoryBalances = new Map<string, number>();
  for (const cat of monthResponse.data.month.categories) {
    monthCategoryBalances.set(cat.id, cat.balance);
  }

  // Process credit cards
  const cardInfos: CreditCardInfo[] = [];

  for (const card of creditCards) {
    // Credit card balances are negative when you owe money, positive if overpaid
    // Only treat negative balances as debt
    const amountOwed = card.balance < 0 ? -card.balance : 0;
    const clearedOwed = card.cleared_balance < 0 ? -card.cleared_balance : 0;
    const unclearedOwed = card.uncleared_balance < 0 ? -card.uncleared_balance : 0;

    // Find corresponding payment category
    const paymentCat = paymentCategoryLookup.get(card.name);
    const paymentCategoryBalance = paymentCat
      ? (monthCategoryBalances.get(paymentCat.id) ?? paymentCat.balance)
      : 0;

    // Calculate shortfall (only if there's debt)
    const shortfall = amountOwed - paymentCategoryBalance;

    // Determine status
    let status: CreditCardInfo['status'];
    if (amountOwed === 0 || paymentCategoryBalance >= amountOwed) {
      status = 'covered';
    } else if (paymentCategoryBalance > 0) {
      status = 'partial';
    } else {
      status = 'underfunded';
    }

    cardInfos.push({
      account_name: sanitizeName(card.name),
      balance: amountOwed,
      cleared_balance: clearedOwed,
      uncleared_balance: unclearedOwed,
      payment_category_balance: paymentCategoryBalance,
      payment_shortfall: shortfall > 0 ? shortfall : 0,
      status,
    });
  }

  // Sort by balance (highest first)
  cardInfos.sort((a, b) => b.balance - a.balance);

  // Calculate totals
  const totalBalance = sumMilliunits(cardInfos.map((c) => c.balance));
  const totalPaymentAvailable = sumMilliunits(cardInfos.map((c) => c.payment_category_balance));
  const totalShortfall = sumMilliunits(cardInfos.map((c) => c.payment_shortfall));

  // Determine overall status
  let overallStatus: 'all_covered' | 'some_covered' | 'underfunded';
  let overallMessage: string;

  const coveredCount = cardInfos.filter((c) => c.status === 'covered').length;
  const underfundedCount = cardInfos.filter((c) => c.status === 'underfunded').length;

  if (coveredCount === cardInfos.length) {
    overallStatus = 'all_covered';
    overallMessage = 'All credit card balances are covered by payment categories';
  } else if (underfundedCount === cardInfos.length) {
    overallStatus = 'underfunded';
    overallMessage = `Need ${formatCurrency(totalShortfall)} more to cover all credit cards`;
  } else {
    overallStatus = 'some_covered';
    overallMessage = `${coveredCount} of ${cardInfos.length} cards fully covered`;
  }

  return JSON.stringify(
    {
      status: overallStatus,
      message: overallMessage,
      month: currentMonth,
      summary: {
        total_cards: cardInfos.length,
        total_balance: formatCurrency(totalBalance),
        total_payment_available: formatCurrency(totalPaymentAvailable),
        total_shortfall: formatCurrency(totalShortfall),
        cards_covered: coveredCount,
        cards_partial: cardInfos.filter((c) => c.status === 'partial').length,
        cards_underfunded: underfundedCount,
      },
      credit_cards: cardInfos.map((c) => ({
        account: c.account_name,
        balance: formatCurrency(c.balance),
        cleared: formatCurrency(c.cleared_balance),
        pending: formatCurrency(c.uncleared_balance),
        payment_available: formatCurrency(c.payment_category_balance),
        shortfall: c.payment_shortfall > 0 ? formatCurrency(c.payment_shortfall) : null,
        status: c.status,
      })),
      tips:
        totalShortfall > 0
          ? [
              'Assign funds to credit card payment categories to cover balances',
              'Payment categories auto-fill when you budget for credit card spending',
              'Pay at least the cleared balance to avoid interest',
            ]
          : ['All credit cards are covered - great job!'],
    },
    null,
    2
  );
}
