export interface CodeSection {
  section_id: string;
  section_title: string;
  content: string;
}

const SECTION_HEADING_RE = /^\s*(\d+(?:\.\d+){1,4})\s+(.{2,160}?)\s*$/;
const ARTICLE_RE = /^\s*Article\s+(\d+(?:\.\d+){0,4})\s*[—:-]?\s*(.{2,160}?)\s*$/i;

export function chunkCodeText(rawText: string, maxTokens = 500): CodeSection[] {
  const lines = rawText.split(/\r?\n/);
  const sections: CodeSection[] = [];
  let current: CodeSection | null = null;

  const push = () => {
    if (current && current.content.trim().length > 0) {
      sections.push({
        section_id: current.section_id,
        section_title: current.section_title,
        content: current.content.trim(),
      });
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/ /g, ' ');
    const sectionMatch = line.match(SECTION_HEADING_RE);
    const articleMatch = line.match(ARTICLE_RE);
    if (sectionMatch) {
      push();
      current = {
        section_id: sectionMatch[1],
        section_title: sectionMatch[2].trim(),
        content: '',
      };
      continue;
    }
    if (articleMatch) {
      push();
      current = {
        section_id: articleMatch[1],
        section_title: articleMatch[2].trim(),
        content: '',
      };
      continue;
    }
    if (current) {
      current.content += line + '\n';
    } else if (line.trim().length > 0) {
      current = { section_id: 'preamble', section_title: 'Preamble', content: line + '\n' };
    }
  }
  push();

  return splitOversized(sections, maxTokens);
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function splitOversized(sections: CodeSection[], maxTokens: number): CodeSection[] {
  const out: CodeSection[] = [];
  for (const sec of sections) {
    if (approxTokens(sec.content) <= maxTokens) {
      out.push(sec);
      continue;
    }
    const maxChars = maxTokens * 4;
    const paragraphs = sec.content.split(/\n\s*\n/);
    let bucket = '';
    let part = 1;
    for (const p of paragraphs) {
      if (bucket.length + p.length + 2 > maxChars && bucket.length > 0) {
        out.push({
          section_id: `${sec.section_id}#${part}`,
          section_title: sec.section_title,
          content: bucket.trim(),
        });
        part += 1;
        bucket = '';
      }
      bucket += p + '\n\n';
    }
    if (bucket.trim().length > 0) {
      out.push({
        section_id: `${sec.section_id}${part > 1 ? `#${part}` : ''}`,
        section_title: sec.section_title,
        content: bucket.trim(),
      });
    }
  }
  return out;
}
