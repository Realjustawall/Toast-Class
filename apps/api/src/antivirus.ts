import { createConnection } from 'node:net';
import { createReadStream } from 'node:fs';
import { once } from 'node:events';

export interface FileScanner {
  scan(path: string): Promise<'clean' | 'infected'>;
}

/** clamd INSTREAM: file bytes are streamed; no arbitrary host path is sent. */
export class ClamAVScanner implements FileScanner {
  constructor(
    readonly host: string,
    readonly port = 3310,
    readonly timeoutMs = 20000,
  ) {}
  scan(path: string): Promise<'clean' | 'infected'> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port });
      const file = createReadStream(path, { highWaterMark: 64 * 1024 });
      let response = Buffer.alloc(0),
        settled = false;
      const finish = (result: 'clean' | 'infected' | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        file.destroy();
        socket.destroy();
        result instanceof Error ? reject(result) : resolve(result);
      };
      const timer = setTimeout(
        () => finish(new Error('Malware scanner timed out')),
        this.timeoutMs,
      );
      socket.on('error', () => finish(new Error('Malware scanner unavailable')));
      file.on('error', () => finish(new Error('Unable to read quarantined upload')));
      socket.on('data', (chunk) => {
        response = Buffer.concat([response, chunk]);
        if (response.length > 4096) {
          finish(new Error('Invalid malware scanner response'));
          return;
        }
        const end = response.indexOf(0);
        if (end < 0) return;
        const line = response.subarray(0, end).toString();
        if (line === 'stream: OK') finish('clean');
        else if (/^stream: .+ FOUND$/.test(line)) finish('infected');
        else finish(new Error('Malware scanner did not return a verdict'));
      });
      socket.on('end', () => {
        if (!settled) finish(new Error('Malware scanner closed without a verdict'));
      });
      socket.once('connect', () => {
        void (async () => {
          socket.write('zINSTREAM\0');
          for await (const chunk of file) {
            if (settled) return;
            const data = chunk as Buffer;
            const length = Buffer.alloc(4);
            length.writeUInt32BE(data.length);
            socket.write(length);
            if (!socket.write(data)) await once(socket, 'drain');
          }
          if (!settled) socket.write(Buffer.alloc(4));
        })().catch(() => finish(new Error('Malware scanning failed')));
      });
    });
  }
}
