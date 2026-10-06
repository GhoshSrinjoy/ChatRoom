import { deflateRawSync, deflateSync } from 'node:zlib';

export type PdfPage = { text: string[] } | { image: { width: number; height: number; rgb?: Uint8Array; jpeg?: Buffer } };
/** Builds a small valid PDF: text pages use Helvetica, image pages contain only a picture (like a scan). */
export function makePdf(pages: PdfPage[]): Buffer {
  const objects: Buffer[] = [];
  const add = (body: string | Buffer) => { objects.push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body); return objects.length; };
  const stream = (dict: string, data: Buffer) => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);
  add('<< /Type /Catalog /Pages 2 0 R >>'); add('PAGES'); const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids: number[] = [];
  for (const page of pages) {
    let resources: string, content: Buffer;
    if ('text' in page) {
      const escape = (line: string) => line.replace(/[\\()]/g, c => '\\' + c);
      content = Buffer.from(`BT /F1 14 Tf 18 TL 72 720 Td ${page.text.map(line => `(${escape(line)}) Tj T*`).join(' ')} ET`, 'latin1');
      resources = `<< /Font << /F1 ${font} 0 R >> >>`;
    } else {
      const { width, height, rgb, jpeg } = page.image;
      const image = add(jpeg
        ? stream(`/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, jpeg)
        : stream(`/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, deflateSync(rgb!)));
      content = Buffer.from(`q 468 0 0 ${Math.round(468 * height / width)} 72 200 cm /Im1 Do Q`, 'latin1');
      resources = `<< /XObject << /Im1 ${image} 0 R >> >>`;
    }
    const contents = add(stream('', content));
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents ${contents} 0 R >>`));
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`, 'latin1');
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')], offsets: number[] = [];
  let length = parts[0]!.length;
  objects.forEach((body, index) => {
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    offsets.push(length); parts.push(chunk); length += chunk.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  return Buffer.concat([...parts, Buffer.from(xref, 'latin1')]);
}
/** Builds a zip archive with deflated entries (enough for a minimal .docx). */
export function makeZip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = deflateRawSync(Buffer.from(text)), file = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(Buffer.byteLength(text), 22); local.writeUInt16LE(file.length, 26);
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(8, 10);
    header.writeUInt32LE(data.length, 20); header.writeUInt32LE(Buffer.byteLength(text), 24); header.writeUInt16LE(file.length, 28); header.writeUInt32LE(offset, 42);
    locals.push(local, file, data); central.push(header, file); offset += local.length + file.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
export function docx(paragraphs: string[]): Buffer {
  const body = paragraphs.map(p => `<w:p><w:r><w:t>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`).join('');
  return makeZip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>` });
}
