import { ZipFile } from 'yazl';

export function testPdf(pages = 2) {
  const objects: Buffer[] = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), Buffer.alloc(0)],
    kids: string[] = [];
  for (let index = 0; index < pages; index++) {
    const page = objects.length + 1;
    kids.push(page + ' 0 R');
    objects.push(
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 180] /Contents ${page + 1} 0 R >>`,
      ),
    );
    const commands = Buffer.from(`${0.2 + (index % 2) * 0.4} 0.3 0.1 rg 20 20 100 80 re f`);
    objects.push(
      Buffer.concat([
        Buffer.from(`<< /Length ${commands.length} >>\nstream\n`),
        commands,
        Buffer.from('\nendstream'),
      ]),
    );
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Count ${pages} /Kids [${kids.join(' ')}] >>`);
  const chunks = [Buffer.from('%PDF-1.4\n')],
    offsets = [0];
  let length = chunks[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const piece = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from('\nendobj\n'),
    ]);
    chunks.push(piece);
    length += piece.length;
  }
  chunks.push(
    Buffer.from(
      `xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
        offsets
          .slice(1)
          .map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n')
          .join('') +
        `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(chunks);
}

export async function testDocx() {
  const zip = new ZipFile();
  zip.addBuffer(
    Buffer.from(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    '[Content_Types].xml',
  );
  zip.addBuffer(
    Buffer.from(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    '_rels/.rels',
  );
  zip.addBuffer(
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>TOASTER document conversion</w:t></w:r></w:p><w:p><w:pPr><w:bidi/></w:pPr><w:r><w:t>آموزش و یادگیری</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>',
    ),
    'word/document.xml',
  );
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
  zip.end();
  return done;
}
