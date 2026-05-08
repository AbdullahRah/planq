import { emptyAnnotations, type AnnotationBuckets } from './annotations';

export type FileType = 'pdf' | 'image' | 'dxf' | 'dwg';

export interface ExtractedSheet {
  sheet_name: string;
  file_type: FileType;
  rooms: Array<{ name: string; dimensions?: string; area?: string }>;
  doors: Array<{ location: string; width?: string; type?: string }>;
  corridors: Array<{ location: string; width?: string; length?: string }>;
  stairs: Array<{ location: string; width?: string; rise?: string; run?: string }>;
  egress_paths: Array<{ from: string; to: string; width?: string }>;
  dimensions: Array<{ element: string; value: string; unit: string }>;
  annotations: AnnotationBuckets;
  occupancy_type?: string;
  building_type?: string;
}

export interface Violation {
  type: 'compliance' | 'consistency';
  severity: 'critical' | 'major' | 'minor';
  description: string;
  section_id?: string;
  code_citation?: string;
  affected_sheets?: string[];
  location_hint?: string;
}

export interface AnalysisResult {
  plan_id: string;
  violations: Violation[];
  sheets: ExtractedSheet[];
  sheets_analyzed: number;
  summary: {
    critical: number;
    major: number;
    minor: number;
    compliance: number;
    consistency: number;
  };
}

export interface CodeChunk {
  id: string;
  section_id: string | null;
  section_title: string | null;
  content: string | null;
  similarity?: number;
}

export function emptyExtractedSheet(sheet_name: string, file_type: FileType): ExtractedSheet {
  return {
    sheet_name,
    file_type,
    rooms: [],
    doors: [],
    corridors: [],
    stairs: [],
    egress_paths: [],
    dimensions: [],
    annotations: emptyAnnotations(),
  };
}
