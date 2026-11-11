import { open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname } from 'node:path';
import yauzl from 'yauzl';
import { imageSize } from 'image-size';
import { z } from 'zod';
import { fail } from './errors.js';

export const fileName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (v) => !/[\x00-\x1f\x7f/\\\u202a-\u202e\u2066-\u2069]/u.test(v) && v !== '.' && v !== '..',
    'Invalid file name',
  );
async function officeArchive(path: string, extension: string) {
  const entries = new Set<string>();
  let total = 0,
    count = 0;
  await new Promise<void>((resolve, reject) => {
    yauzl.open(
      path,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) {
          reject(new Error('Invalid office archive'));
          return;
        }
        let done = false;
        const finish = (error?: Error) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          zip.close();
          error ? reject(error) : resolve();
        };
        const timer = setTimeout(
          () => finish(new Error('Office archive inspection timed out')),
          5000,
        );
        zip.on('error', () => finish(new Error('Invalid office archive')));
        zip.on('entry', (entry: yauzl.Entry) => {
          count++;
          total += entry.uncompressedSize;
          if (
            count > 10000 ||
            total > 200 * 1024 * 1024 ||
            entry.uncompressedSize > 50 * 1024 * 1024 ||
            entry.uncompressedSize > Math.max(1, entry.compressedSize) * 100 ||
            entry.fileName.length > 500 ||
            /(^|\/)(vbaProject\.bin|activeX)(\/|$)/i.test(entry.fileName)
          ) {
            finish(new Error('Unsafe or excessively expanded office archive'));
            return;
          }
          entries.add(entry.fileName);
          zip.readEntry();
        });
        zip.once('end', () => finish());
        zip.readEntry();
      },
    );
  });
  if (
    !entries.has('[Content_Types].xml') ||
    !entries.has(extension === '.docx' ? 'word/document.xml' : 'ppt/presentation.xml')
  )
    fail(400, 'Office content does not match the file extension');
}

export async function inspectFile(path: string, name: string) {
  const extension = extname(fileName.parse(name)).toLowerCase();
  const handle = await open(path, 'r');
  const head = Buffer.alloc(
    ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension) ? 1024 * 1024 : 512,
  );
  let bytesRead = 0;
  try {
    bytesRead = (await handle.read(head, 0, head.length, 0)).bytesRead;
  } finally {
    await handle.close();
  }
  const data = head.subarray(0, bytesRead);
  const starts = (bytes: number[]) => data.subarray(0, bytes.length).equals(Buffer.from(bytes));
  const image = (type: string) => {
    let dimensions;
    try {
      dimensions = imageSize(data);
    } catch {
      fail(400, 'Image metadata is invalid or exceeds the inspection limit');
    }
    if (
      !dimensions.width ||
      !dimensions.height ||
      dimensions.width > 16000 ||
      dimensions.height > 16000 ||
      dimensions.width * dimensions.height > 16000000
    )
      fail(400, 'Image dimensions exceed the 16000 pixel / 16 megapixel limit');
    return type;
  };
  if (extension === '.pdf' && data.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (extension === '.png' && starts([137, 80, 78, 71, 13, 10, 26, 10])) return image('image/png');
  if (['.jpg', '.jpeg'].includes(extension) && starts([255, 216, 255])) return image('image/jpeg');
  if (
    extension === '.webp' &&
    data.subarray(0, 4).toString() === 'RIFF' &&
    data.subarray(8, 12).toString() === 'WEBP'
  )
    return image('image/webp');
  if (extension === '.gif' && ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString()))
    return image('image/gif');
  if (['.ppt', '.doc'].includes(extension) && starts([208, 207, 17, 224, 161, 177, 26, 225]))
    return extension === '.ppt' ? 'application/vnd.ms-powerpoint' : 'application/msword';
  if (['.pptx', '.docx'].includes(extension) && starts([80, 75, 3, 4])) {
    try {
      await officeArchive(path, extension);
    } catch (error) {
      if (error instanceof Error) fail(400, error.message);
      throw error;
    }
    return extension === '.pptx'
      ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (extension === '.txt') {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      for await (const chunk of createReadStream(path)) {
        if ((chunk as Buffer).includes(0)) throw new Error('Binary text');
        decoder.decode(chunk as Buffer, { stream: true });
      }
      decoder.decode();
    } catch {
      fail(400, 'Text uploads must contain valid UTF-8 text without NUL bytes');
    }
    return 'text/plain';
  }
  fail(400, 'Unsupported file type or file content does not match its extension');
}
