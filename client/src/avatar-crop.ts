// Avatar cropper: a square stage with a round guide. Drag (or arrow keys) to move,
// wheel / pinch / slider / +− to zoom. The result is drawn into a 256×256 canvas and
// encoded as WebP (PNG where the browser can't, JPEG if that comes out too large), since
// the server has no image libraries and stores exactly what it gets.

import { AVATAR_MAX_BYTES, AVATAR_SIZE } from '../../shared/profile.ts';
import { h } from './dom.ts';
import { icon } from './ui.ts';

/** Largest file we try to open (big phone photos are ~10 MB). */
const SOURCE_MAX_BYTES = 25 * 1024 * 1024;
const MAX_ZOOM = 5;

export async function loadImageFile(file: File): Promise<HTMLImageElement> {
  if (file.size > SOURCE_MAX_BYTES) throw new Error('That file is too large to open (max 25 MB)');
  if (file.type && !file.type.startsWith('image/')) throw new Error('Choose an image file');
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("That image couldn't be opened");
  }
  if (img.naturalWidth < 16 || img.naturalHeight < 16) {
    URL.revokeObjectURL(url);
    throw new Error('That image is too small');
  }
  return img;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export class AvatarCropper {
  readonly el: HTMLElement;
  private readonly img: HTMLImageElement;
  private readonly canvas = h('canvas', { class: 'crop-canvas', 'aria-hidden': 'true' });
  private readonly stage: HTMLElement;
  private readonly slider: HTMLInputElement;
  /** Crop centre in image pixels, and zoom (1 = the short side just fills the square). */
  private cx: number;
  private cy: number;
  private z = 1;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; z: number } | null = null;
  private raf = 0;
  private readonly ro: ResizeObserver;

  constructor(img: HTMLImageElement) {
    this.img = img;
    this.cx = img.naturalWidth / 2;
    this.cy = img.naturalHeight / 2;
    this.stage = h(
      'div',
      {
        class: 'crop-stage',
        tabindex: '0',
        role: 'group',
        'aria-roledescription': 'image cropper',
        'aria-label': 'Crop your picture. Drag or use the arrow keys to move it; scroll, pinch or press + and − to zoom.',
      },
      this.canvas,
      h('span', { class: 'crop-ring', 'aria-hidden': 'true' }),
    );
    this.slider = h('input', { class: 'crop-zoom', type: 'range', min: '0', max: '1000', value: '0', 'aria-label': 'Zoom' });
    const zoomBtn = (dir: 1 | -1): HTMLButtonElement =>
      h(
        'button',
        { class: 'btn ghost small crop-zbtn', type: 'button', 'aria-label': dir > 0 ? 'Zoom in' : 'Zoom out', onclick: () => this.zoomBy(dir > 0 ? 1.2 : 1 / 1.2) },
        icon(dir > 0 ? 'plus' : 'minus'),
      );
    this.el = h('div', { class: 'cropper' }, this.stage, h('div', { class: 'crop-tools' }, zoomBtn(-1), this.slider, zoomBtn(1)));

    this.slider.addEventListener('input', () => {
      this.z = Math.exp((Number(this.slider.value) / 1000) * Math.log(MAX_ZOOM));
      this.clamp();
      this.draw();
    });
    this.stage.addEventListener('pointerdown', (ev) => this.down(ev));
    this.stage.addEventListener('pointermove', (ev) => this.move(ev));
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      this.stage.addEventListener(t, (ev) => {
        this.pointers.delete(ev.pointerId);
        if (this.pointers.size < 2) this.pinch = null;
        if (this.pointers.size === 0) this.stage.classList.remove('dragging');
      });
    }
    this.stage.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        const r = this.stage.getBoundingClientRect();
        this.zoomBy(Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0018)), ev.clientX - r.left, ev.clientY - r.top);
      },
      { passive: false },
    );
    this.stage.addEventListener('keydown', (ev) => this.key(ev));
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.stage);
  }

  /** Side of the stage in CSS pixels. */
  private get side(): number {
    return this.stage.clientWidth || 240;
  }

  /** Stage pixels per image pixel. */
  private get scale(): number {
    return (this.z * this.side) / Math.min(this.img.naturalWidth, this.img.naturalHeight);
  }

  private clamp(): void {
    this.z = Math.min(MAX_ZOOM, Math.max(1, this.z));
    const half = Math.min(this.img.naturalWidth, this.img.naturalHeight) / (2 * this.z);
    this.cx = Math.min(this.img.naturalWidth - half, Math.max(half, this.cx));
    this.cy = Math.min(this.img.naturalHeight - half, Math.max(half, this.cy));
    this.slider.value = String(Math.round((Math.log(this.z) / Math.log(MAX_ZOOM)) * 1000));
  }

  /** Zooms keeping the image point under (px, py) — stage pixels, default the centre — in place. */
  private zoomBy(f: number, px = this.side / 2, py = this.side / 2): void {
    const s0 = this.scale;
    const ix = this.cx + (px - this.side / 2) / s0;
    const iy = this.cy + (py - this.side / 2) / s0;
    this.z *= f;
    this.clamp();
    const s1 = this.scale;
    this.cx = ix - (px - this.side / 2) / s1;
    this.cy = iy - (py - this.side / 2) / s1;
    this.clamp();
    this.draw();
  }

  private panBy(dx: number, dy: number): void {
    const s = this.scale;
    this.cx -= dx / s;
    this.cy -= dy / s;
    this.clamp();
    this.draw();
  }

  private down(ev: PointerEvent): void {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    this.stage.setPointerCapture(ev.pointerId);
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    this.stage.classList.add('dragging');
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: this.z };
    }
  }

  private move(ev: PointerEvent): void {
    const prev = this.pointers.get(ev.pointerId);
    if (!prev) return;
    const next = { x: ev.clientX, y: ev.clientY };
    this.pointers.set(ev.pointerId, next);
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const r = this.stage.getBoundingClientRect();
      const f = (this.pinch.z * (Math.hypot(a.x - b.x, a.y - b.y) / this.pinch.dist)) / this.z;
      this.zoomBy(f, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      // Two fingers moving together also pan (half each, since both pointers report).
      this.panBy((next.x - prev.x) / 2, (next.y - prev.y) / 2);
    } else {
      this.panBy(next.x - prev.x, next.y - prev.y);
    }
  }

  private key(ev: KeyboardEvent): void {
    const step = ev.shiftKey ? 32 : 8;
    switch (ev.key) {
      case 'ArrowLeft':
        this.panBy(step, 0);
        break;
      case 'ArrowRight':
        this.panBy(-step, 0);
        break;
      case 'ArrowUp':
        this.panBy(0, step);
        break;
      case 'ArrowDown':
        this.panBy(0, -step);
        break;
      case '+':
      case '=':
        this.zoomBy(1.15);
        break;
      case '-':
      case '_':
        this.zoomBy(1 / 1.15);
        break;
      default:
        return;
    }
    ev.preventDefault();
  }

  private draw(): void {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => {
      const side = this.side;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const px = Math.round(side * dpr);
      if (this.canvas.width !== px) {
        this.canvas.width = px;
        this.canvas.height = px;
      }
      const g = this.canvas.getContext('2d');
      if (!g) return;
      const crop = this.cropRect();
      g.imageSmoothingQuality = 'high';
      g.clearRect(0, 0, px, px);
      g.drawImage(this.img, crop.x, crop.y, crop.side, crop.side, 0, 0, px, px);
    });
  }

  /** The square of the source image that becomes the avatar. */
  private cropRect(): { x: number; y: number; side: number } {
    const side = Math.min(this.img.naturalWidth, this.img.naturalHeight) / this.z;
    return { x: this.cx - side / 2, y: this.cy - side / 2, side };
  }

  /** The cropped 256×256 picture, encoded small enough for the server. */
  async export(): Promise<Blob> {
    const out = h('canvas', { width: AVATAR_SIZE, height: AVATAR_SIZE });
    const g = out.getContext('2d');
    if (!g) throw new Error("This browser can't prepare images");
    g.imageSmoothingQuality = 'high';
    const crop = this.cropRect();
    // Downscale in halving steps first: one big jump from a 4000 px photo looks grainy.
    let src: CanvasImageSource = this.img;
    let sx = crop.x;
    let sy = crop.y;
    let ss = crop.side;
    while (ss > AVATAR_SIZE * 2.5) {
      const half = Math.round(ss / 2);
      const step = h('canvas', { width: half, height: half });
      const sg = step.getContext('2d');
      if (!sg) break;
      sg.imageSmoothingQuality = 'high';
      sg.drawImage(src, sx, sy, ss, ss, 0, 0, half, half);
      src = step;
      sx = 0;
      sy = 0;
      ss = half;
    }
    g.drawImage(src, sx, sy, ss, ss, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    for (const q of [0.88, 0.78, 0.65]) {
      const webp = await toBlob(out, 'image/webp', q);
      if (!webp || webp.type !== 'image/webp') break;
      if (webp.size <= AVATAR_MAX_BYTES) return webp;
    }
    const png = await toBlob(out, 'image/png');
    if (png && png.size <= AVATAR_MAX_BYTES) return png;
    const jpeg = await toBlob(out, 'image/jpeg', 0.82);
    if (jpeg && jpeg.size <= AVATAR_MAX_BYTES) return jpeg;
    throw new Error("Couldn't make the picture small enough");
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    if (this.img.src.startsWith('blob:')) URL.revokeObjectURL(this.img.src);
  }
}
