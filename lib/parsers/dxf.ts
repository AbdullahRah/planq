import DxfParser from 'dxf-parser';
import type { ExtractedSheet } from '../types';

interface DxfEntity {
  type?: string;
  text?: string;
  startPoint?: { x: number; y: number; z?: number };
  endPoint?: { x: number; y: number; z?: number };
  position?: { x: number; y: number; z?: number };
  measurement?: number;
  layer?: string;
}

export interface ParsedDxf {
  dimensions: ExtractedSheet['dimensions'];
  annotations: string[];
  entityCount: number;
}

export function parseDxf(buffer: Buffer): ParsedDxf {
  const parser = new DxfParser();
  const text = buffer.toString('utf8');
  const dxf = parser.parseSync(text);

  const dimensions: ExtractedSheet['dimensions'] = [];
  const annotations: string[] = [];
  let entityCount = 0;

  const entities = (dxf?.entities ?? []) as DxfEntity[];
  for (const entity of entities) {
    entityCount += 1;
    const type = entity.type ?? '';

    switch (type) {
      case 'LINE': {
        if (entity.startPoint && entity.endPoint) {
          const dx = entity.endPoint.x - entity.startPoint.x;
          const dy = entity.endPoint.y - entity.startPoint.y;
          const length = Math.sqrt(dx * dx + dy * dy);
          dimensions.push({
            element: `LINE ${entity.layer ?? ''}`.trim(),
            value: length.toFixed(2),
            unit: 'units',
          });
        }
        break;
      }
      case 'DIMENSION': {
        const value = entity.measurement;
        if (typeof value === 'number') {
          dimensions.push({
            element: `DIMENSION ${entity.layer ?? ''}`.trim(),
            value: value.toFixed(2),
            unit: 'units',
          });
        }
        if (entity.text) annotations.push(`DIM: ${entity.text}`);
        break;
      }
      case 'TEXT':
      case 'MTEXT': {
        if (entity.text) annotations.push(entity.text);
        break;
      }
      default:
        break;
    }
  }

  return { dimensions, annotations, entityCount };
}

export class DwgUnsupportedError extends Error {
  constructor() {
    super('DWG files are proprietary and not supported. Please convert to DXF and re-upload.');
    this.name = 'DwgUnsupportedError';
  }
}
