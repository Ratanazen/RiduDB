'use strict';

// Typed, credential-safe errors for RiduDB Studio database backend.
// Driver errors are normalized here. Raw driver errors are kept in `original`
// for debugging but must never be logged (they may contain passwords).

const DRIVER_CODES = {
  CONNECTION_FAILED: 'CONNECTION_FAILED',
  CONNECTION_CLOSED: 'CONNECTION_CLOSED',
  INVALID_SQL: 'INVALID_SQL',
  QUERY_CANCELLED: 'QUERY_CANCELLED',
  QUERY_TIMEOUT: 'QUERY_TIMEOUT',
  RESULT_TRUNCATED: 'RESULT_TRUNCATED',
  DRIVER_ERROR: 'DRIVER_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
};

class RiduDBError extends Error {
  constructor({ code, message, driver, original, statusCode } = {}) {
    super(message);
    this.name = 'RiduDBError';
    this.code = code || DRIVER_CODES.DRIVER_ERROR;
    this.driver = driver || 'base';
    this.original = original || null;
    this.statusCode = statusCode || null;
    // Keep stack trace clean.
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RiduDBError);
    }
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      driver: this.driver,
      message: this.message,
      // `original` intentionally excluded from serialization: it may contain
      // credentials or stack details we do not want in logs/sourcemaps.
    };
  }
}

function normalizeDriverError(err, driver) {
  if (err instanceof RiduDBError) return err;
  const message = err && err.message ? String(err.message) : String(err);
  const code = err && err.code ? String(err.code) : DRIVER_CODES.DRIVER_ERROR;
  return new RiduDBError({
    code,
    message,
    driver,
    original: err,
  });
}

module.exports = {
  RiduDBError,
  DRIVER_CODES,
  normalizeDriverError,
};
