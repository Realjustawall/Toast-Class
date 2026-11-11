import { resolve } from 'node:path';
import { z } from 'zod';
import { FileSystemStorage, S3ObjectStorage } from './object-storage.js';
import { ClamAVScanner } from './antivirus.js';
import type { FileConfig } from './files.js';

/** Shared API/worker storage settings. Caller loads its environment, never a job. */
export function fileConfigFromEnvironment(env: NodeJS.ProcessEnv = process.env): FileConfig {
  const production = env.NODE_ENV === 'production';
  if (production && env.FILE_ALLOW_UNSCANNED === 'true')
    throw new Error('Production cannot allow unscanned files');
  const driver = env.FILE_STORAGE_DRIVER ?? (production ? 'disabled' : 'filesystem');
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(name + ' is required');
    return value;
  };
  if (!['filesystem', 's3', 'disabled'].includes(driver))
    throw new Error('Unknown FILE_STORAGE_DRIVER');
  const storage =
    driver === 'filesystem'
      ? new FileSystemStorage(resolve(env.FILE_STORAGE_DIR ?? '.local/storage'))
      : driver === 's3'
        ? new S3ObjectStorage({
            endpoint: required('S3_ENDPOINT'),
            region: required('S3_REGION'),
            bucket: required('S3_BUCKET'),
            accessKeyId: required('S3_ACCESS_KEY_ID'),
            secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
          })
        : undefined;
  return {
    storage,
    allowUnscanned: env.FILE_ALLOW_UNSCANNED === 'true',
    maxUploadBytes: z
      .number()
      .int()
      .min(1)
      .max(100 * 1024 * 1024)
      .parse(Number(env.FILE_MAX_UPLOAD_BYTES ?? 26214400)),
    scanner: env.CLAMAV_HOST
      ? new ClamAVScanner(
          env.CLAMAV_HOST,
          z
            .number()
            .int()
            .min(1)
            .max(65535)
            .parse(Number(env.CLAMAV_PORT ?? 3310)),
        )
      : undefined,
  };
}
