/**
 * Compact zero-dependency Markdown → HTML renderer.
 * Supports: ATX headings, paragraphs, bold/italic/strikethrough, inline code,
 * fenced code blocks, blockquotes, ordered/unordered lists (nested one level),
 * links, images, hr, tables.
 */

import { escapeHtml } from './template.js';

function inline(src: string): string {
  let s = escapeHtml(src);
  // inline code first (protect content)
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // images before links
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, '<img src="$2" alt="$1" loading="lazy">');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  // autolink
  s = s.replace(/(?<![="'>])(https?:\/\/[^\s<]+[^\s<.,)])/g, '<a href="$1">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]);
  return s;
}

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  const listStack: ('ul' | 'ol')[] = [];
  const closeLists = (depth = 0) => {
    while (listStack.length > depth) out.push(`</${listStack.pop()}>`);
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      closeLists();
      const lang = fence[1];
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; // skip closing fence
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      out.push(`<pre><code${cls}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // blank
    if (/^\s*$/.test(line)) {
      closeLists();
      i++;
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      closeLists();
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // hr
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
      closeLists();
      out.push('<hr>');
      i++;
      continue;
    }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      closeLists();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // table
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      closeLists();
      const parseRow = (l: string) =>
        l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => inline(c.trim()));
      const head = parseRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      out.push('<table><thead><tr>' + head.map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>');
      for (const r of rows) out.push('<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>');
      out.push('</tbody></table>');
      continue;
    }

    // list item
    const li = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
    if (li) {
      const depth = li[1].length >= 2 ? 2 : 1;
      const type: 'ul' | 'ol' = /\d+\./.test(li[2]) ? 'ol' : 'ul';
      while (listStack.length > depth) out.push(`</${listStack.pop()}>`);
      while (listStack.length < depth) {
        listStack.push(type);
        out.push(`<${type}>`);
      }
      out.push(`<li>${inline(li[3])}</li>`);
      i++;
      continue;
    }

    // paragraph (merge consecutive plain lines)
    closeLists();
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^(\s*)([-*+]|\d+\.)\s+/.test(lines[i]) &&
      !/^(\*{3,}|-{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${buf.map(inline).join('<br>\n')}</p>`);
  }
  closeLists();
  return out.join('\n');
}

/** Strip markdown to plain text for summaries. */
export function markdownToText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*`~_|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
