/**
 * Audit Log Service
 *
 * Logs all write operations for security and debugging purposes.
 * Logs are stored in memory and can be retrieved via the audit log tool.
 *
 * SECURITY: Audit log entries are accessible via the ynab_audit_log tool.
 * Callers must NOT include sensitive data in the `details` or `error` fields:
 * - No PII (names, addresses, account numbers)
 * - No authentication tokens or credentials
 * - No full payee names or memo contents (use has_payee, has_memo flags instead)
 *
 * Design Decision: The `details` field is NOT sanitized at read time.
 * We rely on callers following the documented contract above. Rationale:
 * 1. All current callers in ynab-client.ts comply (using has_memo, has_name flags)
 * 2. Sanitizing arbitrary nested objects is complex and error-prone
 * 3. Generic sanitization risks false positives (redacting non-sensitive data)
 * 4. The contract is well-documented at both the service and interface level
 *
 * Note: Error messages ARE defensively sanitized (sensitive patterns redacted, then truncated).
 */

import { sanitizeErrorMessage } from '../utils/sanitize.js';

/** Maximum length for error messages in audit entries */
const MAX_ERROR_LENGTH = 500;

/**
 * Represents a single audit log entry.
 *
 * @property details - Metadata about the operation. MUST NOT contain sensitive data (PII, tokens, credentials).
 * @property error - Error message if operation failed. May be exposed via audit log tool.
 */
export interface AuditLogEntry {
  timestamp: string;
  operation: string;
  tool: string;
  budgetId: string;
  resourceType: string;
  resourceId?: string;
  /** Operation metadata. MUST NOT contain PII, tokens, or other sensitive data. */
  details: Record<string, unknown>;
  success: boolean;
  /** Error message if failed. Avoid including sensitive information. */
  error?: string;
}

export class AuditLog {
  private readonly entries: AuditLogEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries: number = 1000) {
    this.maxEntries = maxEntries;
  }

  /**
   * Log a write operation.
   *
   * SECURITY: The `details` field MUST NOT contain sensitive data (PII, tokens,
   * full payee names, memo contents). Use boolean flags like `has_payee` instead.
   * This data is accessible via the ynab_audit_log tool.
   */
  log(entry: Omit<AuditLogEntry, 'timestamp'>): void {
    // Defensively sanitize error messages: redact sensitive patterns and truncate
    let sanitizedError: string | undefined;
    if (entry.error !== undefined) {
      sanitizedError = sanitizeErrorMessage(entry.error, MAX_ERROR_LENGTH);
    }

    const fullEntry: AuditLogEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };
    // Only set error if it exists (exactOptionalPropertyTypes compliance)
    if (sanitizedError !== undefined) {
      fullEntry.error = sanitizedError;
    }

    this.entries.push(fullEntry);

    // Trim old entries if over limit
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    // Also log to stderr for server-side visibility
    const status = entry.success ? 'SUCCESS' : 'FAILED';
    const resourceInfo = entry.resourceId ? ` (${entry.resourceId})` : '';
    console.error(
      `[AUDIT] ${status}: ${entry.operation} on ${entry.resourceType}${resourceInfo} via ${entry.tool}`
    );
  }

  /**
   * Get all log entries.
   */
  getAll(): AuditLogEntry[] {
    return [...this.entries];
  }

  /**
   * Get entries filtered by criteria.
   */
  getFiltered(options: {
    operation?: string;
    tool?: string;
    budgetId?: string;
    resourceType?: string;
    success?: boolean;
    since?: string;
    limit?: number;
  }): AuditLogEntry[] {
    // Create shallow copy immediately to avoid mutating internal state
    let filtered = [...this.entries];

    if (options.operation) {
      filtered = filtered.filter((e) => e.operation === options.operation);
    }
    if (options.tool) {
      filtered = filtered.filter((e) => e.tool === options.tool);
    }
    if (options.budgetId) {
      filtered = filtered.filter((e) => e.budgetId === options.budgetId);
    }
    if (options.resourceType) {
      filtered = filtered.filter((e) => e.resourceType === options.resourceType);
    }
    if (options.success !== undefined) {
      filtered = filtered.filter((e) => e.success === options.success);
    }
    if (options.since !== undefined) {
      const sinceDate = options.since;
      filtered = filtered.filter((e) => e.timestamp >= sinceDate);
    }

    // Return most recent first
    filtered.reverse();

    if (options.limit) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered;
  }

  /**
   * Get summary statistics.
   */
  getSummary(): {
    totalOperations: number;
    successCount: number;
    failureCount: number;
    byOperation: Record<string, number>;
    byResourceType: Record<string, number>;
    oldestEntry?: string;
    newestEntry?: string;
  } {
    const byOperation: Record<string, number> = {};
    const byResourceType: Record<string, number> = {};
    let successCount = 0;
    let failureCount = 0;

    for (const entry of this.entries) {
      byOperation[entry.operation] = (byOperation[entry.operation] ?? 0) + 1;
      byResourceType[entry.resourceType] = (byResourceType[entry.resourceType] ?? 0) + 1;
      if (entry.success) {
        successCount++;
      } else {
        failureCount++;
      }
    }

    const result: {
      totalOperations: number;
      successCount: number;
      failureCount: number;
      byOperation: Record<string, number>;
      byResourceType: Record<string, number>;
      oldestEntry?: string;
      newestEntry?: string;
    } = {
      totalOperations: this.entries.length,
      successCount,
      failureCount,
      byOperation,
      byResourceType,
    };

    const oldest = this.entries[0]?.timestamp;
    const newest = this.entries[this.entries.length - 1]?.timestamp;
    if (oldest !== undefined) result.oldestEntry = oldest;
    if (newest !== undefined) result.newestEntry = newest;

    return result;
  }

  /**
   * Clear all entries.
   */
  clear(): number {
    const count = this.entries.length;
    this.entries.length = 0;
    return count;
  }
}

// Singleton instance
let auditLogInstance: AuditLog | null = null;

export function getAuditLog(): AuditLog {
  if (!auditLogInstance) {
    auditLogInstance = new AuditLog();
  }
  return auditLogInstance;
}

/**
 * Reset the singleton instance for testing isolation.
 * @internal - Only use in test code
 */
export function _resetAuditLogForTesting(): void {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('_resetAuditLogForTesting cannot be called in production');
  }
  auditLogInstance = null;
}
