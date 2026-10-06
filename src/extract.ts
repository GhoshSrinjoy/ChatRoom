import { deflateSync, inflateRawSync } from 'node:zlib';
import { extname } from 'node:path';
import { getDocumentProxy, extractImages } from 'unpdf';
import { RoomDocument } from './types';

export type DocumentKind = RoomDocument['kind'];
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
export const DOCUMENT_EXTENSIONS = ['.pdf', '.docx', ...IMAGE_EXTENSIONS];
export const MAX_DOCUMENT_BYTES = 40_000_000;
export interface Extracted { kind: DocumentKind; text: string; pages?: number; ocrPages?: number; unread?: number }
export interface ExtractOptions {
  /** Reads a PNG/JPEG/WebP image. Without it, scanned pages and images are reported as unreadable. */
  ocr?: (image: Uint8Array, label: string) => Promise<string>;
  progress?: (detail: string) => void;
  signal?: AbortSignal;
  maxOcrPages?: number;
}
export function documentKind(name: string, bytes?: Uint8Array): DocumentKind | undefined {
  const ext = extname(name).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (!bytes || !bytes.subarray(0, 8000).includes(0)) return 'text';
}
export async function extractDocument(name: string, bytes: Uint8Array, options: ExtractOptions = {}): Promise<Extracted> {
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error('Documents must be smaller than 40 MB.');
  const kind = documentKind(name, bytes);
  if (!kind) throw new Error(`${name} is a binary file Chatroom cannot read. Use PDF, Word (.docx), PNG, JPEG, WebP or a text file.`);
  if (kind === 'text') return { kind, text: Buffer.from(bytes).toString('utf8').replace(/^﻿/, '') };
  if (kind === 'docx') {
    const xml = unzipEntry(Buffer.from(bytes), 'word/document.xml');
    if (!xml) throw new Error(`${name} has no Word document body.`);
    return { kind, text: docxText(xml.toString('utf8')) };
  }
  if (kind === 'image') {
    if (!options.ocr) throw new Error('Choose a local vision/OCR model in the Tools tab to read images.');
    return { kind, text: (await options.ocr(bytes, name)).trim(), ocrPages: 1 };
  }
  return extractPdf(bytes, options);
}
async function extractPdf(bytes: Uint8Array, options: ExtractOptions): Promise<Extracted> {
  // pdf.js may transfer the buffer it is given; keep the caller's bytes intact.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const pages: string[] = [], maxOcr = options.maxOcrPages ?? 40;
  let ocrPages = 0, unread = 0;
  try {
    for (let number = 1; number <= pdf.numPages; number++) {
      options.signal?.throwIfAborted();
      options.progress?.(`Reading page ${number} of ${pdf.numPages}`);
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      let text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : '') : '').join('').replace(/[ \t]+\n/g, '\n').trim();
      // A page without a text layer is a scan: read its largest image with the OCR model.
      if (text.replace(/\s/g, '').length < 25) {
        const image = (await extractImages(pdf, number)).sort((a, b) => b.width * b.height - a.width * a.height)[0];
        if (image && image.width * image.height >= 40_000 && options.ocr && ocrPages < maxOcr) {
          options.progress?.(`OCR page ${number} of ${pdf.numPages}`);
          const scanned = (await options.ocr(encodePng(flatten(image)), `page ${number}`)).trim();
          if (scanned) { text = scanned; ocrPages++; }
        } else if (image) unread++;
      }
      pages.push(text);
      page.cleanup();
    }
  } finally { await pdf.loadingTask.destroy(); }
  const body = pages.map((text, index) => `[Page ${index + 1}]\n${text || '(no readable text)'}`).join('\n\n');
  const note = unread ? `\n\n[${unread} scanned page(s) were not read: ${options.ocr ? `the OCR limit is ${maxOcr} pages` : 'choose a local vision/OCR model in the Tools tab'}.]` : '';
  return { kind: 'pdf', text: body + note, pages: pages.length, ocrPages, unread };
}
interface RawImage { data: Uint8Array | Uint8ClampedArray; width: number; height: number; channels: number }
/** Converts to RGB over white, then box-downscales so the long side is at most `maxSide`. */
export function flatten(image: RawImage, maxSide = 2000): RawImage {
  const { data, width, height, channels } = image, factor = Math.max(1, Math.ceil(Math.max(width, height) / maxSide));
  const w = Math.max(1, Math.floor(width / factor)), h = Math.max(1, Math.floor(height / factor)), out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) {
      const i = ((y * factor + dy) * width + x * factor + dx) * channels;
      const alpha = channels === 4 ? data[i + 3]! / 255 : channels === 2 ? data[i + 1]! / 255 : 1, paper = 255 * (1 - alpha);
      const step = channels >= 3 ? 1 : 0;
      r += data[i]! * alpha + paper; g += data[i + step]! * alpha + paper; b += data[i + 2 * step]! * alpha + paper;
    }
    const o = (y * w + x) * 3, area = factor * factor;
    out[o] = Math.round(r / area); out[o + 1] = Math.round(g / area); out[o + 2] = Math.round(b / area);
  }
  return { data: out, width: w, height: h, channels: 3 };
}
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes: Uint8Array): number { let c = 0xffffffff; for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function encodePng(image: RawImage): Buffer {
  const { data, width, height, channels } = image, colorType = ({ 1: 0, 2: 4, 3: 2, 4: 6 } as Record<number, number>)[channels];
  if (colorType === undefined) throw new Error('Unsupported image channel count.');
  const stride = width * channels, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = colorType;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** Reads one entry from a zip archive (stored or deflated), enough for Office Open XML files. */
export function unzipEntry(zip: Buffer, name: string): Buffer | undefined {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (zip.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('The file is not a valid Office document.');
  let offset = zip.readUInt32LE(end + 16);
  for (let i = 0, count = zip.readUInt16LE(end + 10); i < count; i++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('The Office document is damaged.');
    const method = zip.readUInt16LE(offset + 10), size = zip.readUInt32LE(offset + 20), nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30), commentLength = zip.readUInt16LE(offset + 32), local = zip.readUInt32LE(offset + 42);
    if (zip.toString('utf8', offset + 46, offset + 46 + nameLength) === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28), body = zip.subarray(start, start + size);
      if (method === 0) return body;
      if (method === 8) return inflateRawSync(body, { maxOutputLength: 64_000_000 });
      throw new Error('The Office document uses an unsupported compression method.');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
}
export function docxText(xml: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return xml.replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<w:(?:br|cr)\b[^>]*\/>|<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (all, dec, hex, name) => dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : entities[name] ?? all)
    .replace(/\n{3,}/g, '\n\n').trim();
}
