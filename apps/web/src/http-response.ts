export class ResponseError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly retryAfterMs = 0,
  ) {
    super(message);
    this.name = 'ResponseError';
  }
}

/** Proxies and interrupted deployments can return empty or HTML error bodies. */
export async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    /* Never expose proxy HTML to users. */
  }
  const error =
    data && typeof data === 'object' && 'error' in data
      ? (data as { error: unknown }).error
      : undefined;
  if (!response.ok) {
    const code =
      response.status === 429
        ? 'requestRateLimited'
        : response.status >= 500
          ? 'serverUnavailable'
          : 'requestFailed';
    const retry = response.headers.get('retry-after'),
      seconds = Number(retry),
      retryAfterMs =
        response.status === 429
          ? Math.max(
              1000,
              Math.min(
                300000,
                retry
                  ? Number.isFinite(seconds)
                    ? seconds * 1000
                    : Date.parse(retry) - Date.now()
                  : 1000,
              ),
            )
          : 0;
    throw new ResponseError(
      code,
      response.status,
      response.status === 429 ? code : typeof error === 'string' ? error : code,
      Number.isFinite(retryAfterMs) ? retryAfterMs : 1000,
    );
  }
  if (response.status === 204) return undefined as T;
  if (data === undefined)
    throw new ResponseError('incompleteResponse', response.status, 'incompleteResponse');
  return data as T;
}
