/** MCP session caps and idle timeout. */

import { parseBoundedInteger } from '../parse.js';
import type { HttpLoader } from './types.js';

export interface SessionSettings {
  /** Maximum concurrent MCP sessions (`MCP_MAX_SESSIONS`). */
  maxSessions: number;
  /** Maximum concurrent sessions per user (`MCP_MAX_SESSIONS_PER_USER`); past it the user's least recently used one is closed. */
  maxSessionsPerUser: number;
  /** Idle time in ms after which a session is closed (`MCP_SESSION_IDLE_TIMEOUT_MS`). */
  sessionIdleTimeoutMs: number;
}

export const loadSessionSettings: HttpLoader<SessionSettings> = ({ env, problems }) => {
  // A per-user cap above the global one would never close a session, so one
  // user could take every slot. An explicit value is rejected; the default
  // follows a smaller global cap.
  const maxSessions = problems.capture(
    'MCP_MAX_SESSIONS', () => parseBoundedInteger(env['MCP_MAX_SESSIONS'], 100, 'MCP_MAX_SESSIONS', 1, 100_000), 100);
  const maxSessionsPerUser = problems.capture(
    'MCP_MAX_SESSIONS_PER_USER',
    () => parseBoundedInteger(
      env['MCP_MAX_SESSIONS_PER_USER'], Math.min(10, maxSessions), 'MCP_MAX_SESSIONS_PER_USER', 1, 100_000),
    Math.min(10, maxSessions)
  );
  if (maxSessionsPerUser > maxSessions && !problems.failed('MCP_MAX_SESSIONS_PER_USER')) {
    problems.add('MCP_MAX_SESSIONS_PER_USER', 'Invalid MCP_MAX_SESSIONS_PER_USER: must not exceed MCP_MAX_SESSIONS.');
  }
  return {
    maxSessions,
    maxSessionsPerUser,
    sessionIdleTimeoutMs: problems.capture(
      'MCP_SESSION_IDLE_TIMEOUT_MS',
      () => parseBoundedInteger(
        env['MCP_SESSION_IDLE_TIMEOUT_MS'], 30 * 60 * 1000, 'MCP_SESSION_IDLE_TIMEOUT_MS', 1, 24 * 3600 * 1000),
      30 * 60 * 1000
    ),
  };
};
