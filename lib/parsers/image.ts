import sharp from 'sharp';

export interface ParsedImage {
  dataUrl: string;
  mimeType: string;
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
};

function extToMime(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'image/png';
}

export async function parseImage(buffer: Buffer, filename: string): Promise<ParsedImage> {
  let working = buffer;
  let mimeType = extToMime(filename);

  if (mimeType === 'image/tiff') {
    working = await sharp(buffer).png().toBuffer();
    mimeType = 'image/png';
  } else {
    working = await sharp(buffer)
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .toBuffer();
  }

  const base64 = working.toString('base64');
  return { dataUrl: `data:${mimeType};base64,${base64}`, mimeType };
}
