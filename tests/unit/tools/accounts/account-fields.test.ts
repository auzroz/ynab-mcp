/**
 * Account Fields Tests
 */

import { describe, it, expect } from 'vitest';
import type { Account } from 'ynab';
import { accountDetailFields } from '../../../../src/tools/accounts/account-fields.js';
import { mockCheckingAccount } from '../fixtures/index.js';

describe('accountDetailFields', () => {
  it('reports direct import fields as null when YNAB omits them', () => {
    const account = {
      ...mockCheckingAccount,
      direct_import_linked: undefined,
      direct_import_in_error: undefined,
    } as unknown as Account;

    const fields = accountDetailFields(account, { includeEmptyMaps: false });

    expect(fields['direct_import_linked']).toBeNull();
    expect(fields['direct_import_in_error']).toBeNull();
  });

  it('keeps explicit direct import values, including false', () => {
    const account = {
      ...mockCheckingAccount,
      direct_import_linked: false,
      direct_import_in_error: true,
    } as unknown as Account;

    const fields = accountDetailFields(account, { includeEmptyMaps: false });

    expect(fields['direct_import_linked']).toBe(false);
    expect(fields['direct_import_in_error']).toBe(true);
  });
});
