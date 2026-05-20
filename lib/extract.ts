import { openrouter, MODELS, readChoiceText, safeJsonParse } from './openrouter';
import {
  categorizeAnnotations,
  emptyAnnotations,
  isAnnotationBuckets,
  type AnnotationBuckets,
} from './annotations';
import { emptyExtractedSheet, type ExtractedSheet, type FileType } from './types';

const EXTRACTION_SCHEMA = `{
  "sheet_name": "string",
  "file_type": "pdf | image | dxf | dwg",
  "rooms": [{ "name": "string", "dimensions": "string?", "area": "string?" }],
  "doors": [{ "location": "string", "width": "string?", "type": "string?" }],
  "corridors": [{ "location": "string", "width": "string?", "length": "string?" }],
  "stairs": [{ "location": "string", "width": "string?", "rise": "string?", "run": "string?" }],
  "egress_paths": [{ "from": "string", "to": "string", "width": "string?" }],
  "dimensions": [{ "element": "string", "value": "string", "unit": "string" }],
  "annotations": ["string"],
  "occupancy_type": "string?",
  "building_type": "string?"
}`;

const SYSTEM_PROMPT = `You are a building plan analyzer. Extract all spatial and dimensional information from this architectural drawing. Return ONLY valid JSON matching this schema:\n${EXTRACTION_SCHEMA}\nBe thorough — capture every room, door, corridor, stair, dimension annotation, and egress path visible. If something is not present, return an empty array. Do not include any prose outside the JSON.`;

const TEXT_ONLY_SYSTEM_PROMPT = `You are a building plan analyzer. The drawing image could not be processed by the vision model — work only from the embedded text that was extracted from the plan. Extract whatever spatial and dimensional information you can confidently infer from labels, schedules, and notes. Return ONLY valid JSON matching this schema:\n${EXTRACTION_SCHEMA}\nIf a field cannot be inferred from the text, return an empty array. Do not invent data. Do not include any prose outside the JSON.`;

async function extractFromText(args: {
  sheetName: string;
  fileType: FileType;
  text: string;
}): Promise<{ extraction: RawExtraction; error?: string }> {
  const { sheetName, fileType, text } = args;
  const trimmed = text.trim();
  if (trimmed.length < 20) {
    return { extraction: {} as RawExtraction, error: 'no usable text' };
  }
  try {
    const completion = await openrouter.chat.completions.create({
      model: MODELS.reasoning,
      temperature: 0.1,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: TEXT_ONLY_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Sheet name: ${sheetName}\nFile type: ${fileType}\nExtracted plan text:\n${trimmed.slice(0, 12000)}\n\nReturn JSON only.`,
        },
      ],
      ...({ reasoning: { exclude: true } } as Record<string, unknown>),
    });
    const raw = readChoiceText(completion.choices?.[0]?.message as never);
    const parsed = safeJsonParse<RawExtraction>(raw, {} as RawExtraction);
    return { extraction: parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[extract] text-only fallback failed for ${sheetName}`, err);
    return { extraction: {} as RawExtraction, error: message };
  }
}

async function extractOnePage(args: {
  sheetName: string;
  fileType: FileType;
  imageDataUrl: string;
  pageIndex: number;
  pageCount: number;
  textHint?: string;
}): Promise<{ extraction: RawExtraction; raw: string; error?: string }> {
  const { sheetName, fileType, imageDataUrl, pageIndex, pageCount, textHint } = args;

  const userContent: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  > = [
    {
      type: 'text',
      text: `Sheet name: ${sheetName} (page ${pageIndex + 1} of ${pageCount})\nFile type: ${fileType}\n${
        textHint ? `Embedded text hint:\n${textHint.slice(0, 6000)}\n` : ''
      }Extract structured data for THIS page per the schema. Output strict JSON only.`,
    },
    { type: 'image_url', image_url: { url: imageDataUrl } },
  ];

  try {
    const completion = await openrouter.chat.completions.create({
      model: MODELS.vision,
      temperature: 0.1,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent as unknown as string },
      ],
      // OpenRouter passthrough: let reasoning models think internally but only
      // emit the final answer in `content`. Without this, free Nemotron VL
      // burns the budget on chain-of-thought and returns empty content.
      ...({ reasoning: { exclude: true } } as Record<string, unknown>),
    });

    const raw = readChoiceText(completion.choices?.[0]?.message as never);
    const parsed = safeJsonParse<RawExtraction>(raw, {} as RawExtraction);
    return { extraction: parsed, raw };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[extract] vision call failed for ${sheetName} page ${pageIndex + 1}`, err);
    return { extraction: {} as RawExtraction, raw: '', error: message };
  }
}

function combineExtractions(
  sheetName: string,
  fileType: FileType,
  pages: RawExtraction[],
  textHint: string | undefined,
): ExtractedSheet {
  const base = emptyExtractedSheet(sheetName, fileType);
  const merged: ExtractedSheet = {
    ...base,
    sheet_name: sheetName,
    file_type: fileType,
  };

  const rawAnnotations: string[] = [];
  const annotationBuckets: AnnotationBuckets[] = [];

  for (const p of pages) {
    if (Array.isArray(p.rooms)) merged.rooms.push(...p.rooms);
    if (Array.isArray(p.doors)) merged.doors.push(...p.doors);
    if (Array.isArray(p.corridors)) merged.corridors.push(...p.corridors);
    if (Array.isArray(p.stairs)) merged.stairs.push(...p.stairs);
    if (Array.isArray(p.egress_paths)) merged.egress_paths.push(...p.egress_paths);
    if (Array.isArray(p.dimensions)) merged.dimensions.push(...p.dimensions);
    if (Array.isArray(p.annotations)) rawAnnotations.push(...p.annotations);
    else if (isAnnotationBuckets(p.annotations)) annotationBuckets.push(p.annotations);
    if (!merged.occupancy_type && p.occupancy_type) merged.occupancy_type = p.occupancy_type;
    if (!merged.building_type && p.building_type) merged.building_type = p.building_type;
  }

  if (textHint) rawAnnotations.push(textHint);
  let combined = rawAnnotations.length > 0 ? categorizeAnnotations(rawAnnotations) : emptyAnnotations();
  for (const bucket of annotationBuckets) {
    combined = {
      rooms: [...combined.rooms, ...bucket.rooms],
      doors: [...combined.doors, ...bucket.doors],
      dimensions: [...combined.dimensions, ...bucket.dimensions],
      levels: [...combined.levels, ...bucket.levels],
      totals: [...combined.totals, ...bucket.totals],
      sections: [...combined.sections, ...bucket.sections],
      other: [...combined.other, ...bucket.other],
    };
  }
  merged.annotations = combined;
  return merged;
}

export async function extractSheetFromImage(args: {
  sheetName: string;
  fileType: FileType;
  imageDataUrls: string[];
  textHint?: string;
}): Promise<ExtractedSheet> {
  const { sheetName, fileType, imageDataUrls, textHint } = args;

  if (imageDataUrls.length === 0) {
    // No page images rendered — try the text-only path before giving up.
    if (textHint && textHint.trim().length >= 20) {
      const fallback = await extractFromText({ sheetName, fileType, text: textHint });
      const rescued = combineExtractions(sheetName, fileType, [fallback.extraction], textHint);
      rescued.annotations = {
        ...rescued.annotations,
        other: [
          ...rescued.annotations.other,
          'EXTRACT_FALLBACK: pdf renderer produced no page images — used embedded text only',
        ],
      };
      return rescued;
    }
    const annotationBuckets = textHint ? categorizeAnnotations([textHint]) : emptyAnnotations();
    return {
      ...emptyExtractedSheet(sheetName, fileType),
      annotations: {
        ...annotationBuckets,
        other: [
          ...annotationBuckets.other,
          'EXTRACT_EMPTY: pdf renderer produced no page images',
        ],
      },
    };
  }

  const pageLimit = Math.min(imageDataUrls.length, 6);
  const extractions: RawExtraction[] = [];
  const errors: string[] = [];
  let nonEmptyContent = false;

  for (let i = 0; i < pageLimit; i++) {
    const result = await extractOnePage({
      sheetName,
      fileType,
      imageDataUrl: imageDataUrls[i],
      pageIndex: i,
      pageCount: pageLimit,
      textHint,
    });
    if (result.error) errors.push(`page ${i + 1}: ${result.error}`);
    if (result.raw) nonEmptyContent = true;
    extractions.push(result.extraction);
    if (i < pageLimit - 1) await delay(750);
  }

  const merged = combineExtractions(sheetName, fileType, extractions, textHint);

  const isEmpty =
    merged.rooms.length === 0 &&
    merged.doors.length === 0 &&
    merged.corridors.length === 0 &&
    merged.stairs.length === 0 &&
    merged.egress_paths.length === 0 &&
    merged.dimensions.length === 0;

  // planq.md fallback: if vision returned nothing usable but we still have
  // embedded PDF text, try a text-only pass with the reasoning model before
  // giving up. This rescues text-heavy plans when the free vision model fails.
  const visionFailed = isEmpty && !nonEmptyContent;
  if (visionFailed && textHint && textHint.trim().length >= 20) {
    const fallback = await extractFromText({ sheetName, fileType, text: textHint });
    if (fallback.extraction && Object.keys(fallback.extraction).length > 0) {
      const rescued = combineExtractions(sheetName, fileType, [fallback.extraction], textHint);
      const rescuedHasData =
        rescued.rooms.length > 0 ||
        rescued.doors.length > 0 ||
        rescued.corridors.length > 0 ||
        rescued.stairs.length > 0 ||
        rescued.egress_paths.length > 0 ||
        rescued.dimensions.length > 0;
      if (rescuedHasData) {
        rescued.annotations = {
          ...rescued.annotations,
          other: [
            ...rescued.annotations.other,
            'EXTRACT_FALLBACK: vision empty — extracted from embedded text only',
          ],
        };
        return rescued;
      }
    }
    if (fallback.error) errors.push(`text fallback: ${fallback.error}`);
  }

  if (errors.length > 0) {
    merged.annotations = {
      ...merged.annotations,
      other: [...merged.annotations.other, ...errors.map((e) => `VISION_ERROR: ${e}`)],
    };
  } else if (visionFailed) {
    merged.annotations = {
      ...merged.annotations,
      other: [
        ...merged.annotations.other,
        'EXTRACT_EMPTY: vision model returned no usable content',
      ],
    };
  }

  return merged;
}

export type RawExtraction = Omit<Partial<ExtractedSheet>, 'annotations'> & {
  annotations?: string[] | AnnotationBuckets;
};

export function mergeExtraction(
  sheetName: string,
  fileType: FileType,
  partial: RawExtraction,
): ExtractedSheet {
  const base = emptyExtractedSheet(sheetName, fileType);
  let annotations: AnnotationBuckets;
  if (Array.isArray(partial.annotations)) {
    annotations = categorizeAnnotations(partial.annotations);
  } else if (isAnnotationBuckets(partial.annotations)) {
    annotations = partial.annotations;
  } else {
    annotations = base.annotations;
  }

  return {
    sheet_name: partial.sheet_name || sheetName,
    file_type: (partial.file_type as FileType) || fileType,
    rooms: Array.isArray(partial.rooms) ? partial.rooms : base.rooms,
    doors: Array.isArray(partial.doors) ? partial.doors : base.doors,
    corridors: Array.isArray(partial.corridors) ? partial.corridors : base.corridors,
    stairs: Array.isArray(partial.stairs) ? partial.stairs : base.stairs,
    egress_paths: Array.isArray(partial.egress_paths) ? partial.egress_paths : base.egress_paths,
    dimensions: Array.isArray(partial.dimensions) ? partial.dimensions : base.dimensions,
    annotations,
    occupancy_type: partial.occupancy_type,
    building_type: partial.building_type,
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
