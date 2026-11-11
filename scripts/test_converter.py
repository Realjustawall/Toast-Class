"""Real Linux-only converter image smoke/negative tests; never invokes user documents."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid
import zipfile


def pdf_fixture(count):
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'']
    kids = []
    for i in range(count):
        page_id = len(objects) + 1
        kids.append(f'{page_id} 0 R')
        objects.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 180] /Contents {page_id+1} 0 R >>'.encode())
        commands = f'{0.2 + (i % 2) * 0.4} 0.3 0.1 rg 20 20 100 80 re f'.encode()
        objects.append(b'<< /Length ' + str(len(commands)).encode() + b' >>\nstream\n' + commands + b'\nendstream')
    objects[1] = f'<< /Type /Pages /Count {count} /Kids [{" ".join(kids)}] >>'.encode()
    data = b'%PDF-1.4\n'
    offsets = [0]
    for i, obj in enumerate(objects):
        offsets.append(len(data))
        data += f'{i+1} 0 obj\n'.encode() + obj + b'\nendobj\n'
    start = len(data)
    data += f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode()
    data += b''.join(f'{offset:010d} 00000 n \n'.encode() for offset in offsets[1:])
    return data + f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n'.encode()


def office_fixture(path):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as doc:
        doc.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        doc.writestr('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        doc.writestr('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>TOASTER document conversion</w:t></w:r></w:p><w:p><w:pPr><w:bidi/></w:pPr><w:r><w:t>آموزش و یادگیری</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>')


def check(extension, data, pages=None, failure=None, prepare=None):
    root = Path(tempfile.mkdtemp(prefix='toaster-conversion-test-')).resolve()
    name = 'toaster-conversion-test-' + uuid.uuid4().hex
    try:
        source, output = root / 'input', root / 'output'
        source.mkdir(mode=0o755)
        output.mkdir(mode=0o777)
        output.chmod(0o777)
        file = source / ('source.' + extension)
        if prepare:
            prepare(file)
        else:
            file.write_bytes(data)
        file.chmod(0o444)
        command = ['docker', 'run', '--rm', '--name', name, '--network', 'none',
                   '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                   '--pids-limit', '128', '--memory', '768m', '--memory-swap', '768m',
                   '--cpus', '1', '--user', '65532:65532',
                   '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=268435456,mode=1777',
                   '--mount', f'type=bind,source={source},target=/input,readonly',
                   '--mount', f'type=bind,source={output},target=/output',
                   'toaster-converter', extension]
        result = subprocess.run(command, capture_output=True, text=True, timeout=150)
        if failure:
            assert result.returncode != 0, 'Invalid input must fail'
            assert json.loads(result.stdout)['code'] == failure, result.stdout
            assert not (output / 'manifest.json').exists()
        else:
            assert result.returncode == 0, result.stdout + result.stderr
            manifest = json.loads((output / 'manifest.json').read_text())
            assert manifest['version'] == 1 and manifest['pageCount'] == pages
            assert len(manifest['pages']) == pages
            assets = [manifest['pdf'], *manifest['pages']]
            assert {p.name for p in output.iterdir()} == {'manifest.json', *[a['name'] for a in assets]}
            for path in output.iterdir():
                assert path.stat().st_mode & 0o777 == 0o640, 'Only converter owner and trusted worker group may read output'
                assert path.stat().st_gid == 65532, 'Output must use the isolated converter/worker artifact group'
            for entry in assets:
                content = (output / entry['name']).read_bytes()
                assert len(content) == entry['byteSize']
                assert hashlib.sha256(content).hexdigest() == entry['sha256']
            for page in manifest['pages']:
                assert 0 < page['width'] <= 1600 and 0 < page['height'] <= 1600
            if extension == 'pdf':
                assert (output / 'document.pdf').read_bytes() == data
        print(f'PASS: {extension}, ' + (failure if failure else f'{pages} rendered pages'))
    finally:
        # Only the freshly generated test-owned name can be targeted. Confirm it
        # is gone before removing directories that may have been mounted.
        subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=15)
        inspection = subprocess.run(['docker', 'inspect', name], capture_output=True, timeout=15)
        if inspection.returncode == 0 or b'no such' not in inspection.stderr.lower():
            raise RuntimeError('Cannot confirm test container removal; preserving ' + str(root))
        parent = Path(tempfile.gettempdir()).resolve()
        if root.parent != parent or not root.name.startswith('toaster-conversion-test-') or root.is_symlink():
            raise RuntimeError('Refusing unsafe test cleanup')
        shutil.rmtree(root)


if __name__ == '__main__':
    if os.name != 'posix':
        raise RuntimeError('Run this harness on the Linux Docker host')
    check('pdf', pdf_fixture(2), pages=2)
    check('txt', 'TOASTER workshop\nآموزش و یادگیری'.encode(), pages=1)
    check('docx', None, pages=1, prepare=office_fixture)
    check('pdf', b'%PDF-not-a-real-document', failure='document_processing_failed')
    check('pdf', pdf_fixture(201), failure='page_count_limit')
