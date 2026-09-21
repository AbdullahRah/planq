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

/**
 * The outcome of the TypeSafe (Jev) verification gate for a model-authored
 * finding. See lib/verify.ts. Rule-engine findings are never verified this way
 * and carry no verification block.
 */
export interface ViolationVerification {
  /**
   * verified      — the cited section supports the requirement and the plan shows the element
   * unsupported   — the cited section does not address the requirement; citation was removed
   * contradicted  — the cited section states a different requirement (finding dropped)
   * ungrounded    — the extracted plan data does not contain the element (finding dropped)
   * needs_review  — the model was not confident enough to decide on its own
   * unchecked     — verification was disabled or unavailable
   */
  verdict: 'verified' | 'unsupported' | 'contradicted' | 'ungrounded' | 'needs_review' | 'unchecked';
  relation?: 'supports' | 'contradicts' | 'says_nothing';
  relation_confidence?: number;
  grounded?: number;
  model?: string;
  note?: string;
}

export interface Violation {
  type: 'compliance' | 'consistency';
  severity: 'critical' | 'major' | 'minor';
  description: string;
  section_id?: string;
  code_citation?: string;
  affected_sheets?: string[];
  location_hint?: string;
  // Provenance: 'rule_engine' for deterministic checks, 'llm' for model output.
  source?: 'rule_engine' | 'llm';
  // Present only on model-authored findings that went through lib/verify.ts.
  verification?: ViolationVerification;
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
  warnings?: string[];
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
