import { mkdtemp, rm, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, relative, isAbsolute } from 'node:path';
import { FileSystemStorage } from '../apps/api/src/object-storage';

export async function testStorage() {
  const root = await mkdtemp(join(tmpdir(), 'toaster-files-test-'));
  const created = await lstat(root);
  return {
    root,
    storage: new FileSystemStorage(join(root, 'objects')),
    cleanup: async () => {
      const target = await realpath(root),
        parent = await realpath(tmpdir()),
        within = relative(parent, target);
      const current = await lstat(root);
      if (
        !within ||
        isAbsolute(within) ||
        within.startsWith('..') ||
        !within.startsWith('toaster-files-test-') ||
        within !== basename(target) ||
        current.isSymbolicLink() ||
        current.dev !== created.dev ||
        current.ino !== created.ino
      )
        throw new Error('Refusing to remove an unverified test directory');
      await rm(target, { recursive: true, force: true });
    },
  };
}
