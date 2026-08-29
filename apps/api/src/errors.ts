/**
 * WorkTracker error types. Every error has a stable code (the
 * `ErrorCode` enum in ./local-types/index) so callers can branch
 * on it without parsing messages.
 */

import type { ErrorCode } from './local-types/index';

export class WorkTrackerError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, status?: number, details?: Record<string, unknown>) {
    super(message);
    this.name = 'WorkTrackerError';
    this.code = code;
    this.status = status ?? defaultStatusFor(code);
    this.details = details;
  }
}

export class InvalidInputError extends WorkTrackerError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('invalid_input', message, 400, details);
    this.name = 'InvalidInputError';
  }
}

export class UnauthorizedError extends WorkTrackerError {
  constructor(message = 'unauthorized') {
    super('unauthorized', message, 401);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends WorkTrackerError {
  constructor(message = 'forbidden') {
    super('forbidden', message, 403);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends WorkTrackerError {
  constructor(message: string) {
    super('not_found', message, 404);
    this.name = 'NotFoundError';
  }
}

export class VersionConflictError extends WorkTrackerError {
  constructor(message = 'version conflict', details?: Record<string, unknown>) {
    super('version_conflict', message, 409, details);
    this.name = 'VersionConflictError';
  }
}

export class RateLimitedError extends WorkTrackerError {
  constructor(message = 'rate limited') {
    super('rate_limited', message, 429);
    this.name = 'RateLimitedError';
  }
}

export class SourceUnavailableError extends WorkTrackerError {
  constructor(message: string) {
    super('source_unavailable', message, 502);
    this.name = 'SourceUnavailableError';
  }
}

function defaultStatusFor(code: ErrorCode): number {
  switch (code) {
    case 'invalid_input':
      return 400;
    case 'unauthorized':
      return 401;
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'version_conflict':
      return 409;
    case 'rate_limited':
      return 429;
    case 'source_unavailable':
      return 502;
    case 'internal_error':
    default:
      return 500;
  }
}
