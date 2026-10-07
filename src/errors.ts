export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'MISSING_IDEMPOTENCY_KEY'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'REQUEST_IN_PROGRESS'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INSUFFICIENT_FUNDS'
  | 'INVALID_STATE'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';

/** A business error: the request is understood and rejected. Safe to show to the client. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const errors = {
  validation: (m: string) => new AppError(400, 'VALIDATION_ERROR', m),
  missingKey: () =>
    new AppError(400, 'MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header (a UUID) is required on every POST'),
  keyReused: () =>
    new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request body'),
  inProgress: () =>
    new AppError(409, 'REQUEST_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed'),
  unauthenticated: (m = 'Missing or invalid X-User-Id header') => new AppError(401, 'UNAUTHENTICATED', m),
  forbidden: (m = 'You are not allowed to do that') => new AppError(403, 'FORBIDDEN', m),
  notFound: (what: string) => new AppError(404, 'NOT_FOUND', `${what} not found`),
  insufficientFunds: (balance: number, needed: number) =>
    new AppError(
      422,
      'INSUFFICIENT_FUNDS',
      `Wallet has ${balance} paise but ${needed} paise are needed`,
    ),
  invalidState: (m: string) => new AppError(409, 'INVALID_STATE', m),
  conflict: (m: string) => new AppError(409, 'CONFLICT', m),
};

export function errorBody(e: AppError, requestId: string) {
  return { code: e.code, message: e.message, request_id: requestId };
}
