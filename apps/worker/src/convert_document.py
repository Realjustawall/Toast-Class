"""One isolated document job. Run only inside the restricted converter container.

No storage credentials or network access are needed. Input is a fixed source file;
output is a PDF, bounded raster pages and a versioned integrity manifest.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import resource
import signal
import struct
import subprocess
import sys
import time

MAX_BYTES = 100 * 1024 * 1024
MAX_PAGES = 200
DEADLINE = time.monotonic() + 120
INPUT = Path('/input')
OUTPUT = Path('/output')


class ConversionError(Exception):
    pass


def run(args, capture=False):
    remaining = DEADLINE - time.monotonic()
    if remaining <= 0:
        raise ConversionError('conversion_timeout')
    target = Path('/tmp/tool-output')
    with target.open('wb') as stdout:
        process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=stdout,
                                   stderr=subprocess.DEVNULL, start_new_session=True,
                                   env={'PATH': '/usr/bin:/bin', 'HOME': '/tmp',
                                        'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
                                        'SAL_USE_VCLPLUGIN': 'svp'})
        try:
            code = process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise ConversionError('conversion_timeout')
    if code != 0:
        raise ConversionError('document_processing_failed')
    if capture:
        if target.stat().st_size > 65536:
            raise ConversionError('document_metadata_limit')
        return target.read_text(encoding='utf-8', errors='replace')
    return ''


def asset(path):
    if path.is_symlink() or not path.is_file():
        raise ConversionError('invalid_output')
    size = path.stat().st_size
    if size < 1 or size > MAX_BYTES:
        raise ConversionError('output_size_limit')
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(65536):
            digest.update(chunk)
    return {'name': path.name, 'byteSize': size, 'sha256': digest.hexdigest()}


def main():
    if os.getuid() == 0:
        raise ConversionError('converter_must_run_unprivileged')
    if len(sys.argv) != 2 or sys.argv[1] not in (
            'pdf', 'doc', 'docx', 'ppt', 'pptx', 'txt', 'png', 'jpg', 'jpeg', 'gif', 'webp'):
        raise ConversionError('unsupported_document')
    extension = sys.argv[1]
    source = INPUT / ('source.' + extension)
    if source.is_symlink() or not source.is_file() or not 0 < source.stat().st_size <= MAX_BYTES:
        raise ConversionError('invalid_input')
    if any(OUTPUT.iterdir()):
        raise ConversionError('output_directory_must_be_empty')
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_BYTES, MAX_BYTES))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    pdf = OUTPUT / 'document.pdf'
    if extension == 'pdf':
        with source.open('rb') as original, pdf.open('xb') as destination:
            while chunk := original.read(65536):
                destination.write(chunk)
    else:
        profile = Path('/tmp/office-profile/user')
        profile.mkdir(parents=True)
        # A fresh profile, disabled macros and no JRE. Headless alone is not a sandbox.
        (profile / 'registrymodifications.xcu').write_text(
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<oor:items xmlns:oor="http://openoffice.org/2001/registry">'
            '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">'
            '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>'
            '</item></oor:items>', encoding='utf-8')
        converted = Path('/tmp/converted')
        converted.mkdir()
        command = ['libreoffice', '-env:UserInstallation=file:///tmp/office-profile',
                   '--headless', '--nologo', '--nodefault', '--norestore',
                   '--convert-to', 'pdf', '--outdir', str(converted)]
        if extension == 'txt':
            command.append('--infilter=Text (encoded):UTF8,LF,Liberation Mono,en-US')
        run(command + [str(source)])
        result = converted / 'source.pdf'
        if result.is_symlink() or not result.is_file():
            raise ConversionError('document_conversion_failed')
        if not 0 < result.stat().st_size <= MAX_BYTES:
            raise ConversionError('output_size_limit')
        with result.open('rb') as original, pdf.open('xb') as destination:
            while chunk := original.read(65536):
                destination.write(chunk)
    document = asset(pdf)
    with pdf.open('rb') as stream:
        if stream.read(5) != b'%PDF-':
            raise ConversionError('invalid_pdf_output')
    info = run(['pdfinfo', str(pdf)], capture=True)
    if re.search(r'^Encrypted:\s+yes', info, re.MULTILINE):
        raise ConversionError('encrypted_document_unsupported')
    counts = re.findall(r'^Pages:\s+(\d+)\s*$', info, re.MULTILINE)
    if not counts or not 1 <= int(counts[-1]) <= MAX_PAGES:
        raise ConversionError('page_count_limit')
    pages = []
    total = document['byteSize']
    for number in range(1, int(counts[-1]) + 1):
        name = f'page-{number:04d}'
        run(['pdftoppm', '-f', str(number), '-l', str(number), '-singlefile',
             '-scale-to', '1600', '-png', str(pdf), str(OUTPUT / name)])
        path = OUTPUT / (name + '.png')
        entry = asset(path)
        with path.open('rb') as image:
            header = image.read(24)
        if len(header) != 24 or header[:8] != b'\x89PNG\r\n\x1a\n' or header[12:16] != b'IHDR':
            raise ConversionError('invalid_page_output')
        width, height = struct.unpack('>II', header[16:24])
        if min(width, height) < 1 or max(width, height) > 1600:
            raise ConversionError('page_dimension_limit')
        total += entry['byteSize']
        if total > MAX_BYTES:
            raise ConversionError('output_size_limit')
        pages.append({**entry, 'number': number, 'width': width, 'height': height})
    manifest = {'version': 1, 'pageCount': len(pages), 'pdf': document, 'pages': pages}
    with (OUTPUT / 'manifest.json').open('x', encoding='utf-8') as target:
        json.dump(manifest, target, ensure_ascii=False)
    # The untrusted converter UID differs from the trusted non-root worker.
    # Share only final artifacts with GID 65532; profile/temp files stay private.
    for name in ['document.pdf', 'manifest.json', *[page['name'] for page in pages]]:
        path = OUTPUT / name
        if path.is_symlink() or not path.is_file():
            raise ConversionError('invalid_page_output')
        os.chmod(path, 0o640, follow_symlinks=False)
    print(json.dumps({'status': 'completed', 'pageCount': len(pages)}))


if __name__ == '__main__':
    try:
        main()
    except ConversionError as error:
        print(json.dumps({'status': 'failed', 'code': str(error)}))
        sys.exit(1)
    except Exception:
        # Parser/tool errors must not leak document content or host paths.
        print(json.dumps({'status': 'failed', 'code': 'document_processing_failed'}))
        sys.exit(1)
