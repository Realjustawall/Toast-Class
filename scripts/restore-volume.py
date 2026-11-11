"""Read a trusted authenticated backup part; never extract tar links or unsafe paths."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import sys
import tarfile


class ArchiveError(ValueError):
    pass


def process(stream, destination=None, owner=0):
    if os.name != 'posix' or owner not in (0, 1000):
        raise ArchiveError('Unsupported restore platform/owner')
    root = None
    if destination is not None:
        root = Path(destination)
        if not root.is_absolute() or root.is_symlink() or not root.is_dir() or any(root.iterdir()):
            raise ArchiveError('Restore requires an empty volume directory')
        root = root.resolve()
        os.chmod(root, 0o700)
        os.chown(root, owner, owner)
    seen = set()
    directories = {'.'}
    summary = hashlib.sha256()
    total = 0
    count = 0
    # Uncompressed streaming only; no gzip decompression or extractall behavior.
    with tarfile.open(fileobj=stream, mode='r|') as archive:
        for member in archive:
            count += 1
            if count > 1_000_000 or len(member.name) > 4096:
                raise ArchiveError('Archive metadata limit exceeded')
            name = PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or any(ord(c) < 32 or ord(c) == 127 for c in member.name):
                raise ArchiveError('Unsafe volume path')
            normalized = str(name)
            if normalized != '.' and str(name.parent) not in directories:
                raise ArchiveError('Archive directories must precede their children')
            if normalized in seen:
                raise ArchiveError('Duplicate volume path')
            seen.add(normalized)
            if member.type not in (tarfile.DIRTYPE, tarfile.REGTYPE, tarfile.AREGTYPE) or member.sparse:
                raise ArchiveError('Links/special/sparse volume entries are forbidden')
            if normalized == '.' and not member.isdir():
                raise ArchiveError('Invalid volume root entry')
            target = root.joinpath(*name.parts) if root else None
            if member.isdir():
                directories.add(normalized)
                if target:
                    target.mkdir(parents=True, exist_ok=True, mode=0o700)
                    if target.is_symlink() or not target.is_dir():
                        raise ArchiveError('Invalid restore directory')
                    os.chmod(target, 0o700)
                    os.chown(target, owner, owner)
                continue
            if member.size < 0 or member.size > 1024 * 1024 * 1024:
                raise ArchiveError('Volume object size exceeds current policy')
            total += member.size
            if total > 1024 ** 4:
                raise ArchiveError('Volume restore limit exceeded')
            source = archive.extractfile(member)
            if source is None:
                raise ArchiveError('Missing archive bytes')
            destination_file = None
            if target:
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                if os.statvfs(root).f_bavail * os.statvfs(root).f_frsize < member.size + 16 * 1024 * 1024:
                    raise ArchiveError('Insufficient restore space')
                descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                destination_file = os.fdopen(descriptor, 'wb')
            digest = hashlib.sha256()
            size = 0
            try:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > member.size:
                        raise ArchiveError('Archive object grew')
                    digest.update(chunk)
                    if destination_file:
                        destination_file.write(chunk)
                if size != member.size:
                    raise ArchiveError('Truncated archive object')
                if destination_file:
                    destination_file.flush()
                    os.fsync(destination_file.fileno())
                    os.fchown(destination_file.fileno(), owner, owner)
            finally:
                if destination_file:
                    destination_file.close()
                source.close()
            if target:
                restored = hashlib.sha256()
                with target.open('rb') as result:
                    for chunk in iter(lambda: result.read(1024 * 1024), b''):
                        restored.update(chunk)
                if restored.digest() != digest.digest() or target.stat().st_size != size:
                    raise ArchiveError('Restored object integrity mismatch')
            summary.update(json.dumps([normalized, size, digest.hexdigest()], ensure_ascii=True, separators=(',', ':')).encode() + b'\n')
        # Drain bounded zero padding so the encrypted-part consumer finishes,
        # and reject hidden concatenated archives/trailing payloads.
        padding = 0
        while True:
            tail = archive.fileobj.read(1024 * 1024)
            if not tail:
                break
            padding += len(tail)
            if padding > 1024 * 1024 or any(tail):
                raise ArchiveError('Unexpected data after volume archive')
    return {'members': count, 'bytes': total, 'contentHash': summary.hexdigest()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--destination')
    parser.add_argument('--owner', type=int, default=0)
    args = parser.parse_args()
    try:
        print(json.dumps(process(sys.stdin.buffer, args.destination, args.owner)))
    except ArchiveError as error:
        print(json.dumps({'error': 'unsafe_or_invalid_volume_archive', 'reason': str(error)}), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        # Do not put archived paths, keys or document content in logs.
        print(json.dumps({'error': 'unsafe_or_invalid_volume_archive', 'type': type(error).__name__}), file=sys.stderr)
        sys.exit(1)
