import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { open, lstat, link, unlink, mkdtemp, chmod, rm, realpath } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { tmpdir } from 'node:os';

const magic = Buffer.from('TOASTBK1');
const maximumChunk = 1024 * 1024;
export const backupParts = Object.freeze([
  'configuration.json',
  'database.sql',
  'files.tar',
  'caddy-data.tar',
  'caddy-config.tar',
]);
const integer = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};
async function writeAll(file, bytes) {
  for (let offset = 0; offset < bytes.length;) {
    const result = await file.write(bytes, offset, bytes.length - offset);
    if (!result.bytesWritten) throw new Error('Backup write did not advance');
    offset += result.bytesWritten;
  }
}
function validateKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Use a 32-byte backup key');
}
export async function writeEncryptedBackup(destination, key, sources) {
  validateKey(key);
  const output = resolve(destination),
    parent = await lstat(dirname(output));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (process.platform !== 'win32' && parent.mode & 0o022)
  )
    throw new Error('Use a private non-writable backup parent directory');
  const temporary = output + '.partial-' + randomUUID();
  const file = await open(temporary, 'wx', 0o600),
    identity = await file.stat();
  let closed = false;
  try {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(magic);
    await writeAll(file, Buffer.concat([magic, iv]));
    const encrypted = (bytes) => writeAll(file, cipher.update(bytes));
    const records = [];
    for (const [index, name] of backupParts.entries()) {
      if (sources[index]?.name !== name)
        throw new Error('Backup parts must follow the versioned inventory');
      const label = Buffer.from(name);
      await encrypted(integer(label.length));
      await encrypted(label);
      const hash = createHash('sha256');
      let size = 0n;
      for await (const input of sources[index].stream()) {
        const bytes = Buffer.from(input);
        for (let offset = 0; offset < bytes.length; offset += maximumChunk) {
          const part = bytes.subarray(offset, offset + maximumChunk);
          size += BigInt(part.length);
          hash.update(part);
          await encrypted(integer(part.length));
          await encrypted(part);
        }
      }
      const digest = hash.digest(),
        trailer = Buffer.alloc(40);
      trailer.writeBigUInt64BE(size);
      digest.copy(trailer, 8);
      await encrypted(integer(0));
      await encrypted(trailer);
      records.push({ name, bytes: size.toString(), sha256: digest.toString('hex') });
    }
    if (sources.length !== backupParts.length) throw new Error('Unexpected backup source');
    await encrypted(integer(0));
    await writeAll(file, cipher.final());
    await writeAll(file, cipher.getAuthTag());
    await file.sync();
    await file.close();
    closed = true;
    const current = await lstat(temporary);
    if (
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      !current.isFile() ||
      current.isSymbolicLink()
    )
      throw new Error('Backup temporary file changed');
    // link is atomic and refuses an existing destination; rename would overwrite it.
    await link(temporary, output);
    await unlink(temporary);
    return records;
  } finally {
    if (!closed) await file.close().catch(() => {});
    const current = await lstat(temporary).catch(() => null);
    if (
      current &&
      current.dev === identity.dev &&
      current.ino === identity.ino &&
      current.isFile() &&
      !current.isSymbolicLink()
    )
      await unlink(temporary);
  }
}

async function* plaintext(path, key) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 40) throw new Error('Invalid encrypted backup');
    const header = Buffer.alloc(20),
      tag = Buffer.alloc(16);
    if (
      (await file.read(header, 0, 20, 0)).bytesRead !== 20 ||
      !header.subarray(0, 8).equals(magic)
    )
      throw new Error('Unsupported backup format');
    if ((await file.read(tag, 0, 16, info.size - 16)).bytesRead !== 16)
      throw new Error('Truncated backup');
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(8));
    decipher.setAAD(magic);
    decipher.setAuthTag(tag);
    for await (const bytes of file.createReadStream({
      start: 20,
      end: info.size - 17,
      autoClose: false,
    }))
      yield decipher.update(bytes);
    const end = decipher.final();
    if (end.length) yield end;
  } finally {
    await file.close();
  }
}
class Reader {
  constructor(iterator) {
    this.iterator = iterator[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
  }
  async read(length, allowEnd = false) {
    if (!Number.isInteger(length) || length < 0 || length > maximumChunk)
      throw new Error('Invalid backup frame length');
    while (this.buffer.length < length) {
      const next = await this.iterator.next();
      if (next.done) {
        if (allowEnd && !this.buffer.length) return null;
        throw new Error('Truncated backup frame');
      }
      this.buffer = Buffer.concat([this.buffer, next.value]);
    }
    const result = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return result;
  }
  async close() {
    await this.iterator.return?.();
  }
}
async function consume(path, key, callback) {
  const reader = new Reader(plaintext(path, key)),
    records = [];
  try {
    for (const name of backupParts) {
      const length = (await reader.read(4)).readUInt32BE();
      if (length !== Buffer.byteLength(name) || (await reader.read(length)).toString() !== name)
        throw new Error('Unexpected backup inventory');
      const hash = createHash('sha256');
      let size = 0n,
        completed = false;
      const chunks = async function* () {
        for (;;) {
          const count = (await reader.read(4)).readUInt32BE();
          if (!count) {
            completed = true;
            return;
          }
          const bytes = await reader.read(count);
          hash.update(bytes);
          size += BigInt(bytes.length);
          yield bytes;
        }
      };
      if (callback) await callback(name, chunks());
      else
        for await (const unused of chunks()) {
          void unused;
        }
      if (!completed) throw new Error('Backup consumer must finish each part');
      const trailer = await reader.read(40),
        digest = hash.digest();
      if (trailer.readBigUInt64BE() !== size || !trailer.subarray(8).equals(digest))
        throw new Error('Backup part integrity failed');
      records.push({ name, bytes: size.toString(), sha256: digest.toString('hex') });
    }
    if ((await reader.read(4)).readUInt32BE() !== 0 || (await reader.read(1, true)) !== null)
      throw new Error('Unexpected trailing backup data');
    return records;
  } finally {
    await reader.close();
  }
}

/** Authenticate a PRIVATE encrypted snapshot before exposing any restore bytes. */
export async function openVerifiedBackup(source, key) {
  validateKey(key);
  const original = await lstat(source);
  if (!original.isFile() || original.isSymbolicLink())
    throw new Error('Use a regular encrypted backup file');
  const base = await realpath(tmpdir()),
    directory = await mkdtemp(join(base, 'toaster-backup-verified-'));
  await chmod(directory, 0o700);
  const identity = await lstat(directory),
    snapshot = join(directory, 'encrypted.backup');
  let disposed = false;
  const privateKey = Buffer.from(key);
  const dispose = async () => {
    if (disposed) return;
    const info = await lstat(directory);
    if (
      dirname(directory) !== base ||
      !basename(directory).startsWith('toaster-backup-verified-') ||
      info.isSymbolicLink() ||
      info.dev !== identity.dev ||
      info.ino !== identity.ino
    )
      throw new Error('Refusing unsafe backup cleanup');
    await rm(directory, { recursive: true, force: true });
    privateKey.fill(0);
    disposed = true;
  };
  try {
    const encryptedHash = createHash('sha256');
    const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const current = await input.stat();
      if (!current.isFile() || current.ino !== original.ino || current.dev !== original.dev)
        throw new Error('Backup source changed');
      const output = await open(snapshot, 'wx', 0o600);
      try {
        for await (const bytes of input.createReadStream({ autoClose: false })) {
          encryptedHash.update(bytes);
          await writeAll(output, bytes);
        }
      } finally {
        await output.close();
      }
    } finally {
      await input.close();
    }
    const records = await consume(snapshot, privateKey);
    return {
      records,
      archiveSha256: encryptedHash.digest('hex'),
      consume: (callback) => {
        if (disposed) throw new Error('Verified backup is closed');
        return consume(snapshot, privateKey, callback);
      },
      close: dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
