import { createClient } from '@redis/client';
import { createHash } from 'node:crypto';

/** Performance only: authorization always reads MySQL before this cache is consulted. */
export class OptionalCache {
  private client?: ReturnType<typeof createClient>;
  private pending = new Map<string, Promise<unknown>>();
  private readonly prefix: string;
  private retry?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(
    private readonly url?: string,
    namespace = '',
  ) {
    this.prefix =
      'toaster:v1:' + createHash('sha256').update(namespace).digest('hex').slice(0, 24) + ':';
    if (!url) return;
    this.connect();
  }
  private connect() {
    if (this.closed || !this.url) return;
    const url = this.url;
    const client = (this.client = createClient({
      url,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 256,
      socket: {
        connectTimeout: 400,
        reconnectStrategy:
          url === 'redis://127.0.0.1:6379'
            ? false
            : (retries) => Math.min(500 * 2 ** Math.min(retries, 5), 15000),
      },
    }));
    client.on('error', () => {
      /* Optional service; never expose URLs or credentials in logs. */
    });
    void client.connect().catch(() => {});
  }
  private async command<T>(
    client: NonNullable<OptionalCache['client']>,
    operation: () => Promise<T>,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            if (client.isOpen) client.destroy();
            if (!this.closed && !this.retry)
              this.retry = setTimeout(() => {
                this.retry = undefined;
                this.connect();
              }, 5000);
            reject(new Error('Optional cache deadline exceeded'));
          }, 80);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async read<T>(key: string, load: () => Promise<T>): Promise<T> {
    const client = this.client;
    if (!client?.isReady) return load();
    const full = this.prefix + key;
    try {
      const value = await this.command(client, () => client.get(full));
      if (value !== null && value.length <= 350000) return JSON.parse(value) as T;
    } catch {
      return load();
    }
    const pending = this.pending.get(full);
    if (pending) return pending as Promise<T>;
    const work = (async () => {
      const result = await load();
      const value = JSON.stringify(result);
      if (value.length <= 350000 && client.isReady) {
        try {
          await this.command(client, () => client.set(full, value, { EX: 30 }));
        } catch {}
      }
      return result;
    })();
    this.pending.set(full, work);
    try {
      return await work;
    } finally {
      this.pending.delete(full);
    }
  }
  close() {
    this.closed = true;
    clearTimeout(this.retry);
    if (this.client?.isOpen) this.client.destroy();
    this.pending.clear();
  }
  get available() {
    return this.client?.isReady ?? false;
  }
}
