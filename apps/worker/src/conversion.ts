import {
  mkdtemp,
  mkdir,
  chmod,
  readFile,
  readdir,
  realpath,
  lstat,
  rm,
  open,
} from 'node:fs/promises';
import { constants, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { CONVERSION_OUTPUT_LIMIT, presentationExtensions } from '../../api/src/presentations.js';

const execute = promisify(execFile);
export class ConversionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const asset = z
  .object({
    name: z.string(),
    byteSize: z.number().int().positive().max(CONVERSION_OUTPUT_LIMIT),
    sha256: digest,
  })
  .strict();
const manifestSchema = z
  .object({
    version: z.literal(1),
    pageCount: z.number().int().min(1).max(200),
    pdf: asset,
    pages: z
      .array(
        asset.extend({
          number: z.number().int().min(1).max(200),
          width: z.number().int().min(1).max(1600),
          height: z.number().int().min(1).max(1600),
        }),
      )
      .min(1)
      .max(200),
  })
  .strict();
export type ConvertedAsset = {
  path: string;
  page: number;
  byteSize: number;
  sha256: string;
  width?: number;
  height?: number;
};
export type ConvertedDocument = {
  assets: ConvertedAsset[];
  pageCount: number;
  dispose: () => Promise<void>;
};
export interface DocumentConverter {
  convert(
    input: Readable,
    source: { extension: string; byteSize: number; sha256: string },
  ): Promise<ConvertedDocument>;
}

export async function validateConvertedOutput(directory: string) {
  try {
    const info = await lstat(join(directory, 'manifest.json'));
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536)
      throw new Error('Invalid manifest');
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')),
    );
    if (
      manifest.pdf.name !== 'document.pdf' ||
      manifest.pages.length !== manifest.pageCount ||
      manifest.pages.some(
        (p, index) =>
          p.number !== index + 1 ||
          p.name !== 'page-' + String(index + 1).padStart(4, '0') + '.png',
      )
    )
      throw new Error('Invalid asset names or order');
    const entries = [manifest.pdf, ...manifest.pages];
    if (
      (await readdir(directory)).sort().join('\n') !==
      ['manifest.json', ...entries.map((a) => a.name)].sort().join('\n')
    )
      throw new Error('Unexpected conversion files');
    if (entries.reduce((sum, a) => sum + a.byteSize, 0) > CONVERSION_OUTPUT_LIMIT)
      throw new Error('Output exceeds reservation');
    const assets: ConvertedAsset[] = [];
    for (const [index, entry] of entries.entries()) {
      const path = join(directory, entry.name),
        stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size !== entry.byteSize
      )
        throw new Error('Unsafe or invalid output file');
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)),
        hash = createHash('sha256');
      let count = 0,
        header = Buffer.alloc(0);
      try {
        for await (const part of handle.createReadStream()) {
          const chunk = Buffer.from(part);
          count += chunk.length;
          if (count > entry.byteSize) throw new Error('Output grew');
          if (header.length < 24)
            header = Buffer.concat([header, chunk.subarray(0, 24 - header.length)]);
          hash.update(chunk);
        }
      } finally {
        await handle.close();
      }
      if (count !== entry.byteSize || hash.digest('hex') !== entry.sha256)
        throw new Error('Output integrity mismatch');
      if (index === 0) {
        if (header.subarray(0, 5).toString() !== '%PDF-') throw new Error('Invalid PDF header');
        assets.push({ path, page: 0, byteSize: entry.byteSize, sha256: entry.sha256 });
      } else {
        const page = manifest.pages[index - 1];
        if (
          header.length < 24 ||
          !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          header.subarray(12, 16).toString() !== 'IHDR' ||
          header.readUInt32BE(16) !== page.width ||
          header.readUInt32BE(20) !== page.height
        )
          throw new Error('Invalid raster header/dimensions');
        assets.push({
          path,
          page: page.number,
          byteSize: entry.byteSize,
          sha256: entry.sha256,
          width: page.width,
          height: page.height,
        });
      }
    }
    return { pageCount: manifest.pageCount, assets };
  } catch {
    throw new ConversionError('output_integrity_failed');
  }
}

export class DockerDocumentConverter implements DocumentConverter {
  constructor(
    readonly image = 'toaster-converter',
    readonly workRoot = join(tmpdir(), 'toaster-conversion-jobs'),
  ) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9./:@_-]*$/.test(image))
      throw new Error('Invalid configured converter image');
  }
  async convert(
    input: Readable,
    source: { extension: string; byteSize: number; sha256: string },
  ): Promise<ConvertedDocument> {
    if (process.platform !== 'linux') throw new ConversionError('converter_unavailable');
    if (
      !presentationExtensions.has(source.extension) ||
      !Number.isSafeInteger(source.byteSize) ||
      source.byteSize < 1 ||
      source.byteSize > CONVERSION_OUTPUT_LIMIT ||
      !digest.safeParse(source.sha256).success
    )
      throw new ConversionError('invalid_input');
    await mkdir(this.workRoot, { recursive: true, mode: 0o700 });
    const base = await realpath(this.workRoot),
      root = await mkdtemp(join(base, 'job-')),
      identity = await lstat(root),
      name = 'toaster-conversion-' + randomUUID();
    let canRemove = true,
      removed = false;
    const dispose = async () => {
      if (removed) return;
      if (!canRemove) throw new ConversionError('converter_unavailable');
      const target = await realpath(root),
        within = relative(base, target),
        current = await lstat(root);
      if (
        !within ||
        isAbsolute(within) ||
        within.startsWith('..') ||
        within !== basename(target) ||
        !within.startsWith('job-') ||
        current.isSymbolicLink() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino
      )
        throw new Error('Refusing unsafe conversion workspace cleanup');
      await rm(target, { recursive: true, force: true });
      removed = true;
    };
    try {
      const incoming = join(root, 'input'),
        outgoing = join(root, 'output');
      await mkdir(incoming, { mode: 0o755 });
      await mkdir(outgoing, { mode: 0o777 });
      await chmod(outgoing, 0o777);
      const path = join(incoming, 'source.' + source.extension),
        hash = createHash('sha256');
      let bytes = 0;
      await pipeline(
        input,
        new Transform({
          transform(chunk: Buffer, _enc, done) {
            bytes += chunk.length;
            if (bytes > source.byteSize) {
              done(new ConversionError('input_integrity_failed'));
              return;
            }
            hash.update(chunk);
            done(null, chunk);
          },
        }),
        createWriteStream(path, { flags: 'wx', mode: 0o600 }),
        { signal: AbortSignal.timeout(120000) },
      );
      if (bytes !== source.byteSize || hash.digest('hex') !== source.sha256)
        throw new ConversionError('input_integrity_failed');
      await chmod(path, 0o444);
      if (root.includes(',')) throw new ConversionError('converter_unavailable');
      let result;
      try {
        result = await execute(
          'docker',
          [
            'run',
            '--pull=never',
            '--rm',
            '--name',
            name,
            '--label',
            'toaster.conversion-job=' + name,
            '--network',
            'none',
            '--read-only',
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            '--pids-limit',
            '128',
            '--memory',
            '768m',
            '--memory-swap',
            '768m',
            '--cpus',
            '1',
            '--user',
            '65532:65532',
            '--tmpfs',
            '/tmp:rw,noexec,nosuid,nodev,size=268435456,mode=1777',
            '--mount',
            `type=bind,source=${incoming},target=/input,readonly`,
            '--mount',
            `type=bind,source=${outgoing},target=/output`,
            this.image,
            source.extension,
          ],
          { timeout: 150000, maxBuffer: 65536, encoding: 'utf8' },
        );
      } catch (error) {
        const e = error as Error & { killed?: boolean; stdout?: string; code?: string };
        if (e.killed) throw new ConversionError('conversion_timeout');
        if (e.code === 'ENOENT') throw new ConversionError('converter_unavailable');
        let code = 'document_processing_failed';
        try {
          const response = JSON.parse(e.stdout ?? '');
          if (typeof response.code === 'string' && /^[a-z_]{1,80}$/.test(response.code))
            code = response.code;
        } catch {}
        throw new ConversionError(code);
      } finally {
        // The name is generated here, never accepted from a job or caller.
        try {
          await execute('docker', ['rm', '-f', name], { timeout: 15000, maxBuffer: 16384 });
        } catch (error) {
          if (!/No such (container|object)/i.test((error as { stderr?: string }).stderr ?? ''))
            canRemove = false;
        }
      }
      if (!canRemove) throw new ConversionError('converter_unavailable');
      if (JSON.parse(result.stdout).status !== 'completed')
        throw new ConversionError('document_processing_failed');
      const output = await validateConvertedOutput(outgoing);
      return { ...output, dispose };
    } catch (error) {
      if (canRemove) await dispose();
      throw error;
    }
  }
}
