import { mkdir, open, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream, constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

export interface ObjectStorage {
  close?(): void;
  put(key: string, path: string, size: number, mediaType: string): Promise<void>;
  get(key: string, range?: { start: number; end: number }): Promise<Readable>;
  delete(key: string): Promise<void>;
}

export class FileSystemStorage implements ObjectStorage {
  readonly root: string;
  constructor(directory: string) {
    this.root = resolve(directory);
  }
  private path(key: string) {
    z.uuid().parse(key);
    return join(this.root, key.slice(0, 2), key);
  }
  async put(key: string, source: string, _size: number, _mediaType: string) {
    const target = this.path(key);
    await mkdir(join(this.root, key.slice(0, 2)), { recursive: true, mode: 0o700 });
    try {
      await pipeline(
        createReadStream(source),
        createWriteStream(target, { flags: 'wx', mode: 0o600 }),
      );
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
        await unlink(target).catch(() => {});
      throw error;
    }
  }
  async get(key: string, range?: { start: number; end: number }) {
    const handle = await open(this.path(key), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    return handle.createReadStream({ ...range, autoClose: true });
  }
  async delete(key: string) {
    try {
      await unlink(this.path(key));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
}

export class S3ObjectStorage implements ObjectStorage {
  close() {
    this.client.destroy();
  }
  private readonly client: S3Client;
  constructor(
    readonly settings: {
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
    },
  ) {
    const endpoint = new URL(settings.endpoint);
    if (!['http:', 'https:'].includes(endpoint.protocol))
      throw new Error('S3 endpoint must use HTTP or HTTPS');
    this.client = new S3Client({
      endpoint: settings.endpoint,
      region: settings.region,
      forcePathStyle: true,
      credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  async put(key: string, path: string, size: number, mediaType: string) {
    z.uuid().parse(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.settings.bucket,
        Key: key,
        Body: createReadStream(path),
        ContentLength: size,
        ContentType: mediaType,
        IfNoneMatch: '*',
      }),
      { abortSignal: AbortSignal.timeout(120000) },
    );
  }
  async get(key: string, range?: { start: number; end: number }) {
    z.uuid().parse(key);
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.settings.bucket,
        Key: key,
        Range: range ? `bytes=${range.start}-${range.end}` : undefined,
      }),
      { abortSignal: AbortSignal.timeout(120000) },
    );
    if (!result.Body || !('pipe' in result.Body))
      throw new Error('S3 response has no readable body');
    return result.Body as Readable;
  }
  async delete(key: string) {
    z.uuid().parse(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.settings.bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(15000),
    });
  }
}
