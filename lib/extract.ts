import { openrouter, MODELS, safeJsonParse } from './openrouter';
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

export async function extractSheetFromImage(args: {
  sheetName: string;
  fileType: FileType;
  imageDataUrls: string[];
  textHint?: string;
}): Promise<ExtractedSheet> {
  const { sheetName, fileType, imageDataUrls, textHint } = args;

  if (imageDataUrls.length === 0) {
    return {
      ...emptyExtractedSheet(sheetName, fileType),
      annotations: textHint ? categorizeAnnotations([textHint]) : emptyAnnotations(),
    };
  }

  const userContent: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  > = [
    {
      type: 'text',
      text: `Sheet name: ${sheetName}\nFile type: ${fileType}\n${
        textHint ? `Embedded text hint:\n${textHint.slice(0, 4000)}\n` : ''
      }Extract structured data per the schema. Output strict JSON only.`,
    },
  ];
  for (const url of imageDataUrls.slice(0, 6)) {
    userContent.push({ type: 'image_url', image_url: { url } });
  }

  try {
    const completion = await openrouter.chat.completions.create({
      model: MODELS.vision,
      temperature: 0.1,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent as unknown as string },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content ?? '';
    const parsed = safeJsonParse<RawExtraction>(
      typeof raw === 'string' ? raw : '',
      {} as RawExtraction,
    );

    return mergeExtraction(sheetName, fileType, parsed);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[extract] vision call failed', err);
    return {
      ...emptyExtractedSheet(sheetName, fileType),
      annotations: textHint
        ? categorizeAnnotations([textHint])
        : emptyAnnotations(),
    };
  }
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
