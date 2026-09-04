/**
 * Minimal ID3v2 (2.3/2.4) tag reader: title, artist, album, BPM, key, and artwork presence.
 * Reads only the tag header region, never the audio.
 */

export interface AudioTags {
  title?: string;
  artist?: string;
  album?: string;
  bpm?: number;
  key?: string;
  hasArtwork: boolean;
  artwork?: { mime: string; bytes: Uint8Array };
}

export interface TagOptions {
  artwork?: boolean;
}

function terminator(bytes: Uint8Array, start: number, wide: boolean): number {
  if (!wide) {
    for (let i = start; i < bytes.length; i += 1) if (bytes[i] === 0) return i;
    return bytes.length;
  }
  for (let i = start; i + 1 < bytes.length; i += 2) if (bytes[i] === 0 && bytes[i + 1] === 0) return i;
  return bytes.length;
}

/** APIC frame: encoding, MIME (latin1, 0-terminated), picture type, description, picture data. */
function parseApic(body: Uint8Array): { mime: string; bytes: Uint8Array } | null {
  const encoding = body[0] ?? 0;
  const mimeEnd = terminator(body, 1, false);
  const mime = new TextDecoder("latin1").decode(body.subarray(1, mimeEnd)) || "image/jpeg";
  const descriptionStart = mimeEnd + 2; // skip terminator and picture type
  const wide = encoding === 1 || encoding === 2;
  const descriptionEnd = terminator(body, descriptionStart, wide);
  const dataStart = descriptionEnd + (wide ? 2 : 1);
  if (dataStart >= body.length) return null;
  return { mime, bytes: body.slice(dataStart) };
}

const synchsafe = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) << 21) |
  ((bytes[offset + 1] ?? 0) << 14) |
  ((bytes[offset + 2] ?? 0) << 7) |
  (bytes[offset + 3] ?? 0);

const uint32 = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) << 24) |
  ((bytes[offset + 1] ?? 0) << 16) |
  ((bytes[offset + 2] ?? 0) << 8) |
  (bytes[offset + 3] ?? 0);

function decodeText(bytes: Uint8Array): string {
  const encoding = bytes[0] ?? 0;
  const body = bytes.subarray(1);
  try {
    if (encoding === 1) {
      const bom = (body[0] ?? 0) === 0xff && (body[1] ?? 0) === 0xfe ? "utf-16le" : "utf-16be";
      return new TextDecoder(bom).decode(body.subarray(2)).replace(/\0+$/g, "");
    }
    if (encoding === 2) return new TextDecoder("utf-16be").decode(body).replace(/\0+$/g, "");
    if (encoding === 3) return new TextDecoder("utf-8").decode(body).replace(/\0+$/g, "");
    return new TextDecoder("latin1").decode(body).replace(/\0+$/g, "");
  } catch {
    return "";
  }
}

/** Number of bytes to read from the start of the file to cover the whole ID3v2 tag. */
export function id3HeaderLength(head: Uint8Array): number {
  if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return 0;
  return 10 + synchsafe(head, 6);
}

export function parseId3(bytes: Uint8Array, options: TagOptions = {}): AudioTags {
  const tags: AudioTags = { hasArtwork: false };
  if (id3HeaderLength(bytes) === 0) return tags;
  const version = bytes[3] ?? 0;
  const flags = bytes[5] ?? 0;
  const size = synchsafe(bytes, 6);
  let offset = 10;
  if (flags & 0x40) {
    // Extended header: skip it.
    const extended = version === 4 ? synchsafe(bytes, offset) : uint32(bytes, offset);
    offset += version === 4 ? extended : extended + 4;
  }
  const end = Math.min(bytes.length, 10 + size);
  while (offset + 10 <= end) {
    const id = String.fromCharCode(
      bytes[offset] ?? 0,
      bytes[offset + 1] ?? 0,
      bytes[offset + 2] ?? 0,
      bytes[offset + 3] ?? 0,
    );
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const frameSize = version === 4 ? synchsafe(bytes, offset + 4) : uint32(bytes, offset + 4);
    const bodyStart = offset + 10;
    const bodyEnd = Math.min(end, bodyStart + frameSize);
    if (frameSize <= 0 || bodyStart > end) break;
    const body = bytes.subarray(bodyStart, bodyEnd);
    switch (id) {
      case "TIT2":
        tags.title = decodeText(body);
        break;
      case "TPE1":
        tags.artist = decodeText(body);
        break;
      case "TALB":
        tags.album = decodeText(body);
        break;
      case "TBPM": {
        const bpm = Number.parseFloat(decodeText(body));
        if (Number.isFinite(bpm) && bpm > 0) tags.bpm = bpm;
        break;
      }
      case "TKEY":
        tags.key = decodeText(body);
        break;
      case "APIC": {
        tags.hasArtwork = true;
        if (options.artwork && !tags.artwork) {
          const artwork = parseApic(body);
          if (artwork) tags.artwork = artwork;
        }
        break;
      }
      default:
        break;
    }
    offset = bodyEnd;
  }
  return tags;
}

/** Reads the tag from the beginning of a file without loading the audio. */
export async function readTags(file: Blob, options: TagOptions = {}): Promise<AudioTags> {
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  const length = id3HeaderLength(head);
  if (length === 0) return { hasArtwork: false };
  const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, length + 10)).arrayBuffer());
  return parseId3(bytes, options);
}
