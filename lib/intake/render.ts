// Rasterizing and tiling sheets for the S2 vision pass (PLANQ_SPEC.md §S0).
//
// §S0 asks for overlapping tiles, about four per sheet, at a resolution where
// dimension text is legible, plus a whole-sheet thumbnail for context. The
// overlap matters: a dimension string that straddles a tile boundary is
// unreadable in both halves unless the tiles share a margin.

import { pdfToPng } from 'pdf-to-png-converter';
import sharp from 'sharp';

export interface Tile {
  /** "02-r0c1", stable so a fact's tile reference can be resolved later. */
  id: string;
  row: number;
  col: number;
  png: Buffer;
  /** Where this tile sits on the sheet, in PDF points, for mapping bboxes back. */
  region: { x: number; y: number; width: number; height: number };
}

export interface RenderedSheet {
  sheet: string;
  /** Whole sheet, downscaled, for context. */
  thumbnail: Buffer;
  tiles: Tile[];
  /** Pixels per PDF point used for the tiles. */
  scale: number;
}

/**
 * Target around 2000px on the long edge of each tile. Dimension text on an
 * architectural sheet is often 6-8pt, which needs roughly 4x to stay legible
 * after JPEG/PNG compression.
 */
const TILE_TARGET_PX = 2000;
const OVERLAP_FRACTION = 0.12;

/**
 * Tile a raster sheet that is already an image, with no PDF to rasterize.
 * Same overlap and tile budget as renderSheet so the vision prompt is identical.
 */
export async function renderImageSheet(
  filePath: string,
  sheetNumber: string,
  opts: { rows?: number; cols?: number } = {},
): Promise<RenderedSheet> {
  const { readFileSync } = await import('node:fs');
  const rows = opts.rows ?? 2;
  const cols = opts.cols ?? 2;

  const full = await sharp(readFileSync(filePath)).png().toBuffer();
  const meta = await sharp(full).metadata();
  const pxW = meta.width ?? 0;
  const pxH = meta.height ?? 0;
  if (!pxW || !pxH) throw new Error(`image ${filePath} has no dimensions`);

  const thumbnail = await sharp(full)
    .resize({ width: 1400, withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();

  const tileW = Math.floor(pxW / cols);
  const tileH = Math.floor(pxH / rows);
  const padX = Math.floor(tileW * OVERLAP_FRACTION);
  const padY = Math.floor(tileH * OVERLAP_FRACTION);

  const tiles: Tile[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const left = Math.max(0, c * tileW - padX);
      const top = Math.max(0, r * tileH - padY);
      const width = Math.min(pxW - left, tileW + padX * 2);
      const height = Math.min(pxH - top, tileH + padY * 2);
      const png = await sharp(full)
        .extract({ left, top, width, height })
        .png({ compressionLevel: 9 })
        .toBuffer();
      tiles.push({
        id: `${sheetNumber}-r${r}c${c}`,
        row: r,
        col: c,
        png,
        region: { x: left, y: pxH - top - height, width, height },
      });
    }
  }

  // Scale 1: image pixels are the sheet's own coordinate system here.
  return { sheet: sheetNumber, thumbnail, tiles, scale: 1 };
}

export async function renderSheet(
  pdfPath: string,
  pdfPage: number,
  sheetNumber: string,
  /** The sheet's size in PDF points, from its inventory entry. */
  sizePt: { width: number; height: number },
  opts: { rows?: number; cols?: number } = {},
): Promise<RenderedSheet> {
  const { readFileSync } = await import('node:fs');
  const rows = opts.rows ?? 2;
  const cols = opts.cols ?? 2;

  // pdf-to-png-converter rather than a raw pdfjs canvas render: pdfjs 5.x calls
  // ctx.fill(path, "evenodd"), which @napi-rs/canvas rejects outright, and this
  // package already carries a working canvas binding that this repo ships with.
  const buf = readFileSync(pdfPath);
  const [rendered] = await pdfToPng(buf, {
    pagesToProcess: [pdfPage],
    viewportScale: 4,
    disableFontFace: true,
    useSystemFonts: false,
  });
  if (!rendered?.content) {
    throw new Error(`could not rasterize page ${pdfPage} of ${pdfPath}`);
  }

  const full = rendered.content;
  const meta = await sharp(full).metadata();
  const pxW = meta.width ?? 0;
  const pxH = meta.height ?? 0;
  if (!pxW || !pxH) throw new Error(`rasterized page ${pdfPage} has no dimensions`);

  // Derive the scale from the raster against the known point size. Computing it
  // from the renderer's own reported width gave pxW/pxW = 1, which silently
  // broke every tile region and would have mapped every vision bbox to the
  // wrong place on the sheet.
  const scale = pxW / sizePt.width;

  const thumbnail = await sharp(full)
    .resize({ width: 1400, withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();

  const tileW = Math.floor(pxW / cols);
  const tileH = Math.floor(pxH / rows);
  const padX = Math.floor(tileW * OVERLAP_FRACTION);
  const padY = Math.floor(tileH * OVERLAP_FRACTION);

  const tiles: Tile[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const left = Math.max(0, c * tileW - padX);
      const top = Math.max(0, r * tileH - padY);
      const width = Math.min(pxW - left, tileW + padX * 2);
      const height = Math.min(pxH - top, tileH + padY * 2);

      const png = await sharp(full)
        .extract({ left, top, width, height })
        .png({ compressionLevel: 9 })
        .toBuffer();

      tiles.push({
        id: `${sheetNumber}-r${r}c${c}`,
        row: r,
        col: c,
        png,
        // Back to PDF points, with y flipped: the raster is top-down, the text
        // layer's coordinates are bottom-up.
        region: {
          x: left / scale,
          y: (pxH - top - height) / scale,
          width: width / scale,
          height: height / scale,
        },
      });
    }
  }

  return { sheet: sheetNumber, thumbnail, tiles, scale };
}
