import pdfParse from 'pdf-parse';
import { fromBuffer } from 'pdf2pic';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

export interface ParsedPdf {
  text: string;
  pageImages: string[];
}

export async function parsePdf(buffer: Buffer): Promise<ParsedPdf> {
  const parsed = await pdfParse(buffer);
  const pageCount = parsed.numpages ?? 1;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'planq-pdf-'));
  const pageImages: string[] = [];
  try {
    const convert = fromBuffer(buffer, {
      density: 150,
      format: 'png',
      width: 1600,
      height: 1200,
      savePath: tmpDir,
      saveFilename: 'page',
    });

    const maxPages = Math.min(pageCount, 12);
    for (let i = 1; i <= maxPages; i++) {
      try {
        const result = await convert(i, { responseType: 'base64' });
        const b64 = (result as { base64?: string }).base64;
        if (b64) {
          pageImages.push(`data:image/png;base64,${b64}`);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[pdf] page ${i} render failed`, err);
      }
    }
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return { text: parsed.text ?? '', pageImages };
}
