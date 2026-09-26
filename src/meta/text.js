// Text in containers that predate Unicode: JPEG comments (COM segments, bytes with no
// declared encoding) and PNG text chunks (tEXt is Latin-1, iTXt UTF-8). Shared by the
// converters and the metadata policies, so both write the same bytes.

const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder('utf-8', { fatal: true }), latin1 = new TextDecoder('latin1');
const MAX_SEGMENT = 65533;

/** A COM payload: UTF-8 when it decodes as such (what most writers use today), else Latin-1. */
export function decodeComment(bytes) {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return latin1.decode(bytes);
  }
}

/** A COM payload for `text`: UTF-8, cut at a character boundary to fit one segment. */
export function commentBytes(text) {
  const b = utf8.encode(text);
  if (b.length <= MAX_SEGMENT) return b;
  let end = MAX_SEGMENT;
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--; // not inside a character
  return b.subarray(0, end);
}

const latin1Bytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);

/** A PNG text chunk: tEXt when the text is Latin-1, else iTXt (UTF-8). */
export function pngTextChunk(keyword, text) {
  const k = latin1Bytes(keyword);
  if (/^[\x00-\xff]*$/.test(text) && !text.includes('\0')) return { type: 'tEXt', data: concat(k, Uint8Array.of(0), latin1Bytes(text)) };
  return { type: 'iTXt', data: concat(k, Uint8Array.of(0, 0, 0, 0, 0), utf8.encode(text)) };
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}
