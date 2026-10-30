/**
 * Prompt Errors
 *
 * Typed errors the prompt registry throws so the server can map each one to the
 * correct MCP error code. Anything else is treated as an internal failure.
 */

/** The requested prompt name is not registered. */
export class UnknownPromptError extends Error {
  constructor() {
    super('Unknown prompt');
    this.name = 'UnknownPromptError';
  }
}

/** A known prompt was called with arguments it cannot accept. */
export class InvalidPromptArgumentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPromptArgumentsError';
  }
}
