/** Expected, safe-to-display application failures. Never wrap upstream errors with their raw message. */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
export function fail(statusCode: number, message: string): never {
  throw new HttpError(statusCode, message);
}
