import sharp from 'sharp';

export interface ParsedImage {
  dataUrl: string;
  mimeType: string;
}

export async function parseImage(buffer: Buffer, _filename: string): Promise<ParsedImage> {
  // planq.md §2: resize/normalize, grayscale, sharpen — improves vision/OCR
  // legibility on architectural drawings without bloating payload size.
  const working = await sharp(buffer, { failOn: 'none' })
    .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
    .grayscale()
    .normalize()
    .sharpen()
    .png({ compressionLevel: 9 })
    .toBuffer();

  const base64 = working.toString('base64');
  return { dataUrl: `data:image/png;base64,${base64}`, mimeType: 'image/png' };
}
