import { promises as fs } from 'fs';
import pdfParse from 'pdf-parse';
import { openrouter, MODELS } from './openrouter';
import { supabaseAdmin } from './supabase';
import { chunkCodeText, type CodeSection } from './chunker';

export interface IngestResult {
  chunks_ingested: number;
  jurisdiction: string;
}

async function loadPdf(source: { localPath?: string; storagePath?: string }): Promise<Buffer> {
  if (source.localPath) {
    return fs.readFile(source.localPath);
  }
  if (source.storagePath) {
    const { data, error } = await supabaseAdmin.storage.from('plans').download(source.storagePath);
    if (error || !data) throw new Error(`storage download failed: ${error?.message ?? 'unknown'}`);
    const arrayBuffer = await data.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
  throw new Error('no source provided');
}

async function embed(text: string): Promise<number[]> {
  const response = await openrouter.embeddings.create({
    model: MODELS.embedding,
    input: text,
  });
  const vec = response.data?.[0]?.embedding;
  if (!vec) throw new Error('embedding response missing data');
  return vec as number[];
}

export async function ingestCodePdf(args: {
  localPath?: string;
  storagePath?: string;
  jurisdiction?: string;
  onProgress?: (line: string) => void;
}): Promise<IngestResult> {
  const jurisdiction = args.jurisdiction ?? 'NBC';
  const log = args.onProgress ?? ((s: string) => console.log(s));

  const buffer = await loadPdf({ localPath: args.localPath, storagePath: args.storagePath });
  const parsed = await pdfParse(buffer);
  const sections = chunkCodeText(parsed.text ?? '', 500);
  log(`Parsed ${sections.length} chunks from PDF (${parsed.numpages} pages).`);

  let inserted = 0;
  const batchSize = 16;
  for (let i = 0; i < sections.length; i += batchSize) {
    const batch = sections.slice(i, i + batchSize);
    const embeddings: number[][] = [];
    for (const section of batch) {
      try {
        const text = `${section.section_id} ${section.section_title}\n${section.content}`;
        const vec = await embed(text);
        embeddings.push(vec);
        log(`Ingesting chunk ${i + embeddings.length}/${sections.length}: Section ${section.section_id} — ${section.section_title}`);
      } catch (err) {
        log(`Embedding failed for ${section.section_id}: ${(err as Error).message}`);
        embeddings.push([]);
      }
    }

    const rows = batch
      .map((section: CodeSection, idx: number) => {
        const vec = embeddings[idx];
        if (!vec || vec.length === 0) return null;
        return {
          section_id: section.section_id,
          section_title: section.section_title,
          content: section.content,
          embedding: vec,
          jurisdiction,
          topic: extractTopics(section.section_title),
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    if (rows.length > 0) {
      const { error } = await supabaseAdmin.from('building_code_chunks').insert(rows);
      if (error) {
        log(`Insert error at batch ${i / batchSize}: ${error.message}`);
      } else {
        inserted += rows.length;
      }
    }
  }

  log(`Done. Ingested ${inserted} chunks.`);
  return { chunks_ingested: inserted, jurisdiction };
}

function extractTopics(title: string): string[] {
  const t = title.toLowerCase();
  const topics: string[] = [];
  if (t.includes('egress') || t.includes('exit')) topics.push('egress');
  if (t.includes('door')) topics.push('doors');
  if (t.includes('corridor')) topics.push('corridors');
  if (t.includes('stair')) topics.push('stairs');
  if (t.includes('occupanc')) topics.push('occupancy');
  if (t.includes('fire')) topics.push('fire');
  return topics;
}
