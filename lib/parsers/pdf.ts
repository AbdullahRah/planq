import pdfParse from 'pdf-parse';
import { pdfToPng } from 'pdf-to-png-converter';

export interface ParsedPdf {
  text: string;
  pageImages: string[];
  /**
   * Why rendering produced nothing, when it did. Reported rather than only
   * logged: "no page images" on its own is not something a reader can act on,
   * and the causes differ entirely (a missing pdfjs worker in the deployed
   * bundle, an encrypted file, a corrupt page).
   */
  renderError?: string;
}

const MAX_PAGES = 12;

export async function parsePdf(buffer: Buffer): Promise<ParsedPdf> {
  const parsed = await pdfParse(buffer);
  const pageCount = parsed.numpages ?? 1;
  const pagesToProcess = Array.from(
    { length: Math.min(pageCount, MAX_PAGES) },
    (_, i) => i + 1,
  );

  let pageImages: string[] = [];
  let renderError: string | undefined;
  try {
    const pages = await pdfToPng(buffer, {
      viewportScale: 2.0,
      pagesToProcess,
      disableFontFace: true,
      useSystemFonts: false,
    });
    pageImages = pages
      .map((p) => p.content?.toString('base64'))
      .filter((b): b is string => Boolean(b))
      .map((b) => `data:image/png;base64,${b}`);
  } catch (err) {
    renderError = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('[pdf] render failed', err);
  }

  return { text: parsed.text ?? '', pageImages, renderError };
}
