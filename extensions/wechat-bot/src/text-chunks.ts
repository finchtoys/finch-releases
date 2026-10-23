/** Conservative client bounds, not a claim about the server's undocumented size limit. */
export const TEXT_CHUNK_CHARACTERS = 4000;
export const TEXT_CHUNK_UTF8_BYTES = 4000;

/** Preserve every code point (including surrogate pairs) and all whitespace, without adding labels. */
export function splitText(text: string): string[] {
  const chunks: string[] = [];
  let chunk = '';
  let characters = 0;
  let bytes = 0;
  for (const point of text) {
    const size = Buffer.byteLength(point, 'utf8');
    if (characters >= TEXT_CHUNK_CHARACTERS || bytes + size > TEXT_CHUNK_UTF8_BYTES) {
      chunks.push(chunk);
      chunk = '';
      characters = 0;
      bytes = 0;
    }
    chunk += point;
    characters += 1;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
