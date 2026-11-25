/** Signal that turn metadata no longer matches its snapshot. */
export class StaleTurnError extends Error {
  readonly name = 'StaleTurnError';

  constructor(
    public readonly currentRevision: number,
    public readonly snapshotRevision: number,
  ) {
    super('TURN_METADATA_CHANGED');
  }
}

/** Signal an invalid message. */
export class AgentMessageShapeError extends Error {
  readonly name = 'AgentMessageShapeError';
  constructor() {
    super('INVALID_MESSAGE');
  }
}
/** Signal a rejected policy. */
export class AgentPolicyError extends Error {
  readonly name = 'AgentPolicyError';
  constructor() {
    super('INVALID_POLICY');
  }
}
/** Signal failed authentication. */
export class AgentAuthError extends Error {
  readonly name = 'AgentAuthError';
  constructor() {
    super('AUTH_FAILED');
  }
}
/** Signal an invalid turn. */
export class AgentTurnInvalidError extends Error {
  readonly name = 'AgentTurnInvalidError';
  constructor() {
    super('INVALID_TURN');
  }
}
/** Signal a rate limit. */
export class AgentRateLimitError extends Error {
  readonly name = 'AgentRateLimitError';
  constructor(public readonly code?: string) {
    super('RATE_LIMIT');
  }
}
/** Signal an HTTP failure. */
export class AgentServerError extends Error {
  readonly name = 'AgentServerError';
  constructor(
    public readonly status: number,
    public readonly code?: string,
  ) {
    super('SERVER_ERROR');
  }
}
/** Signal a network failure. */
export class AgentNetworkError extends Error {
  readonly name = 'AgentNetworkError';
  constructor() {
    super('NETWORK_ERROR');
  }
}
