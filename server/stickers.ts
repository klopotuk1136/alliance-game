// Chat stickers from image files in the `stickers/` folder (see stickers/README.md).
// Each subfolder is a pack, loose files at the top form the default pack. The folder is
// scanned at startup and re-scanned when it changes, so dropped-in files show up without
// a restart. Only files in the index are ever served, which also rules out path tricks.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import type { StickerInfo, StickerPack, StickersResponse } from '../shared/protocol.ts';

export const STICKER_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
/** Bigger files are skipped (and logged): stickers load in everyone's chat. */
export const STICKER_MAX_BYTES = 2 * 1024 * 1024;
const PACK_JSON = 'pack.json';
const DEFAULT_PACK = 'default';

interface StickerFile {
  path: string;
  type: string;
  size: number;
  etag: string;
  hash: string;
}

interface PackMeta {
  title?: unknown;
  order?: unknown;
  cover?: unknown;
}

/** A file or folder name we accept in sticker ids and URLs. */
function okName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 120 &&
    !name.startsWith('.') &&
    !/[\\/\u0000-\u001f\u007f]/.test(name)
  );
}

/** "big_thumbs-up" → "big thumbs up" */
function prettyName(file: string): string {
  const base = file.slice(0, file.length - extname(file).length);
  return base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || base;
}

/** Width and height from the file header (PNG, GIF, WebP, JPEG); undefined if unknown. */
export function imageSize(buf: Buffer): { w: number; h: number } | undefined {
  try {
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 12, 16) === 'IHDR') {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      // JPEG: walk the segments to the first start-of-frame marker.
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return undefined;
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
      return undefined;
    }
    if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) };
      }
      if (chunk === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    }
  } catch {
    // fall through: unknown size is fine, the client reserves a square
  }
  return undefined;
}

/** Same bytes in the URL → same file; changed bytes → a new URL, so caches can be forever. */
function stickerUrl(id: string, hash: string): string {
  return `/stickers/${id.split('/').map(encodeURIComponent).join('/')}?v=${hash}`;
}

export class StickerLibrary {
  readonly dir: string;
  private readonly log: (msg: string) => void;
  private files = new Map<string, StickerFile>();
  private packs: StickerPack[] = [];
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private poll: NodeJS.Timeout | null = null;
  private signature = '';

  constructor(dir: string, log: (msg: string) => void = () => undefined) {
    this.dir = resolve(dir);
    this.log = log;
  }

  has(id: string): boolean {
    return this.files.has(id);
  }

  get count(): number {
    return this.files.size;
  }

  list(): StickersResponse {
    return { packs: this.packs };
  }

  /** The file behind a /stickers/<id> URL path (already URL-decoded), if it is a known sticker. */
  file(id: string): StickerFile | undefined {
    return this.files.get(id);
  }

  /** Reads the whole folder again. Cheap: a few dozen small files at most. */
  scan(): void {
    const files = new Map<string, StickerFile>();
    const packs: Array<StickerPack & { order: number }> = [];
    if (existsSync(this.dir)) {
      const top = this.readPack(this.dir, '', files);
      if (top) packs.push(top);
      for (const ent of readdirSync(this.dir, { withFileTypes: true })) {
        if (!ent.isDirectory() || !okName(ent.name)) continue;
        const pack = this.readPack(join(this.dir, ent.name), ent.name, files);
        if (pack) packs.push(pack);
      }
    }
    packs.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    this.files = files;
    this.packs = packs.map(({ order: _order, ...p }) => p);
    this.signature = this.computeSignature();
  }

  private readPack(dir: string, packDir: string, files: Map<string, StickerFile>): (StickerPack & { order: number }) | null {
    let meta: PackMeta = {};
    const metaPath = join(dir, PACK_JSON);
    if (existsSync(metaPath)) {
      try {
        const parsed = JSON.parse(readFileSync(metaPath, 'utf8')) as unknown;
        if (parsed && typeof parsed === 'object') meta = parsed as PackMeta;
      } catch (err) {
        this.log(`stickers: ignoring ${metaPath}: ${(err as Error).message}`);
      }
    }
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && okName(e.name) && STICKER_TYPES[extname(e.name).toLowerCase()])
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const stickers: StickerInfo[] = [];
    for (const name of names) {
      const path = join(dir, name);
      const size = statSync(path).size;
      if (size > STICKER_MAX_BYTES) {
        this.log(`stickers: skipping ${packDir ? `${packDir}/` : ''}${name} (${(size / 1048576).toFixed(1)} MB, max ${STICKER_MAX_BYTES / 1048576} MB)`);
        continue;
      }
      if (size === 0) continue;
      const buf = readFileSync(path);
      const hash = createHash('sha1').update(buf).digest('hex').slice(0, 12);
      const id = packDir ? `${packDir}/${name}` : name;
      files.set(id, { path, type: STICKER_TYPES[extname(name).toLowerCase()], size, hash, etag: `"${hash}"` });
      const dim = imageSize(buf);
      stickers.push({ id, name: prettyName(name), url: stickerUrl(id, hash), ...(dim && dim.w > 0 && dim.h > 0 ? dim : {}) });
    }
    if (!stickers.length) return null;
    const title = typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim().slice(0, 40) : packDir ? packDir.replace(/[_-]+/g, ' ').trim() || packDir : 'Stickers';
    const coverId = typeof meta.cover === 'string' ? (packDir ? `${packDir}/${meta.cover}` : meta.cover) : '';
    const cover = stickers.find((s) => s.id === coverId) ?? stickers[0];
    return {
      id: packDir || DEFAULT_PACK,
      title,
      cover: cover.url,
      stickers,
      order: typeof meta.order === 'number' && Number.isFinite(meta.order) ? meta.order : packDir ? 0 : -1,
    };
  }

  /** Names, sizes and times of everything in the folder: a change means "scan again". */
  private computeSignature(): string {
    const parts: string[] = [];
    const walk = (dir: string, depth: number): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (depth === 0) walk(p, 1);
        } else {
          try {
            const st = statSync(p);
            parts.push(`${p}:${st.size}:${st.mtimeMs}`);
          } catch {
            // vanished mid-walk
          }
        }
      }
    };
    walk(this.dir, 0);
    return parts.sort().join('|');
  }

  private rescanSoon(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const before = this.signature;
      try {
        this.scan();
      } catch (err) {
        this.log(`stickers: rescan failed: ${(err as Error).message}`);
        return;
      }
      if (this.signature !== before) this.log(`stickers: ${this.count} in ${this.packs.length} pack(s) after a change`);
    }, 400);
    this.timer.unref();
  }

  /**
   * Re-scans when files change: fs.watch for a quick reaction, plus a cheap poll every 15 s
   * (watch events can be missed on some file systems and Docker volumes, and the folder may
   * not exist yet).
   */
  watch(): void {
    this.startWatcher();
    this.poll = setInterval(() => {
      if (!this.watcher) this.startWatcher();
      if (this.computeSignature() !== this.signature) this.rescanSoon();
    }, 15_000);
    this.poll.unref();
  }

  private startWatcher(): void {
    if (!existsSync(this.dir)) return;
    try {
      this.watcher = watch(this.dir, { recursive: true, persistent: false }, () => this.rescanSoon());
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      this.watcher = null;
    }
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.poll) clearInterval(this.poll);
  }
}
