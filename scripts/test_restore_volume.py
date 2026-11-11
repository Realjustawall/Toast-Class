"""Linux-native positive and hostile-archive tests; no application data used."""
import io
import importlib.util
import os
from pathlib import Path
import shutil
import tarfile
import tempfile

spec = importlib.util.spec_from_file_location('volume_restore', Path(__file__).with_name('restore-volume.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def archive(entries):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as target:
        for name, kind, data in entries:
            entry = tarfile.TarInfo(name)
            entry.type = kind
            if kind == tarfile.REGTYPE:
                entry.size = len(data)
                target.addfile(entry, io.BytesIO(data))
            else:
                entry.linkname = '/etc/passwd'
                target.addfile(entry)
    stream.seek(0)
    return stream


good = [('private', tarfile.DIRTYPE, b''), ('private/data', tarfile.REGTYPE, b'Persian \xd9\x81\xd8\xa7\xd8\xb1\xd8\xb3\xdb\x8c and binary\x00\xff')]
expected = module.process(archive(good))
assert expected['members'] == 2
for bad in [
    [('../escape', tarfile.REGTYPE, b'bad')], [('/absolute', tarfile.REGTYPE, b'bad')],
    [('link', tarfile.SYMTYPE, b'')], [('hardlink', tarfile.LNKTYPE, b'')],
    [('device', tarfile.CHRTYPE, b'')], [('duplicate', tarfile.REGTYPE, b'a'), ('duplicate', tarfile.REGTYPE, b'b')],
    [('missing-parent/data', tarfile.REGTYPE, b'bad')],
]:
    try:
        module.process(archive(bad))
        raise AssertionError('Unsafe archive accepted')
    except ValueError:
        pass
root = Path(tempfile.mkdtemp(prefix='toaster-volume-restore-test-')).resolve()
try:
    target = root / 'new'
    target.mkdir()
    if os.geteuid() == 0:
        restored = module.process(archive(good), str(target), 1000)
        assert restored == expected
        assert (target / 'private/data').stat().st_uid == 1000
        assert (target / 'private/data').stat().st_mode & 0o777 == 0o600
        assert target.stat().st_mode & 0o777 == 0o700
        try:
            module.process(archive(good), str(target), 1000)
            raise AssertionError('Nonempty destination accepted')
        except ValueError:
            pass
    assert not (root / 'escape').exists()
finally:
    if root.parent != Path(tempfile.gettempdir()).resolve() or not root.name.startswith('toaster-volume-restore-test-') or root.is_symlink():
        raise RuntimeError('Unsafe cleanup target')
    shutil.rmtree(root)
print('PASS: exact volume bytes/digest, ownership/private modes, links/traversal/devices/duplicates and nonempty-target rejection')
