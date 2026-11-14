/************************************************************
 * DJ DIKKAT - Music Bot
 * Now-playing image
 * Draws the player card as a wide PNG (3:1, so Discord fills
 * the message width) in the website's rust theme: the cover
 * blurred behind the card, big cover on the left, a two-line
 * title, the requester and status chips, a thin progress bar
 * between the times. Square corners, round avatar only.
 * Author: Yanoee
 ************************************************************/
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import type { Image, SKRSContext2D } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';

const font = (file: string) => fileURLToPath(new URL(`../../assets/fonts/${file}`, import.meta.url));
GlobalFonts.registerFromPath(font('RobotoCondensed-Regular.ttf'), 'Roboto Condensed');
GlobalFonts.registerFromPath(font('RobotoCondensed-Bold.ttf'), 'Roboto Condensed');
GlobalFonts.registerFromPath(font('RobotoMono-Medium.ttf'), 'Roboto Mono');
// Fallbacks for emoji / Japanese / Korean titles (the VPS has no system fonts for them)
GlobalFonts.registerFromPath(font('NotoSansJP-Bold.ttf'), 'Noto Sans JP');
GlobalFonts.registerFromPath(font('NotoSansKR-Bold.ttf'), 'Noto Sans KR');
GlobalFonts.registerFromPath(font('NotoEmoji-Medium.ttf'), 'Noto Emoji');

// Same tokens as website/core/assets/rust.css (shared with banner-image.ts)
export const C = {
  bg:     '#12110f',
  panel:  '#1c1a17',
  line:   'rgba(226, 219, 211, 0.08)',
  text:   '#e2dbd3',
  muted:  '#9b948b',
  faint:  '#5e5a54',
  accent:    '#3b82c4',
  accentHot: '#4f97da'
};
const FALLBACK = '"Noto Sans JP", "Noto Sans KR", "Noto Emoji"';
export const SANS = `"Roboto Condensed", ${FALLBACK}, sans-serif`;
export const MONO = `"Roboto Mono", ${FALLBACK}, monospace`;

const W = 1440, H = 480, PAD = 40, ART = H - PAD * 2;
const TX = PAD + ART + 48, TW = W - TX - PAD - 8;   // text column
const ART_TIMEOUT_MS = 3000;
const ART_MAX_BYTES = 6 * 1024 * 1024;

export interface NowPlayingImage {
  title: string;
  artist: string | null;
  artworkUrl: string | null;
  positionMs: number;
  lengthMs: number;        // 0 = live
  paused: boolean;
  label: string;           // "NOW PLAYING" / "PAUSED", already translated
  liveLabel: string;
  source: string;
  accent?: string | null;  // the server's card colour (#rrggbb); default the site blue
  // avatar + "Requested by" over the bar. With `title`, `name` holds a {title} slot ("Autoplay · like {title}")
  // and only the title is shortened, so the words around it ("… gibi" in Turkish) stay readable.
  requester?: { name: string; avatarUrl: string | null; label?: string; title?: string } | null;
  chips?: string[];        // what's on (effect, autoplay, loop), already translated; right of the requester
  locale: string;          // for Turkish İ/I when uppercasing
}

/** M:SS or H:MM:SS */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Cut text with … until it fits maxWidth at the current font. */
export function fit(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

/** Fill `template`'s {title} slot, cutting only the title so the whole line fits maxWidth. */
export function fitSlot(ctx: SKRSContext2D, template: string, title: string, maxWidth: number): string {
  const [before, after = ''] = template.split('{title}');
  const room = maxWidth - ctx.measureText(before + after).width;
  if (room < ctx.measureText('Mm…').width) return fit(ctx, template.replace('{title}', title), maxWidth);
  return before + fit(ctx, title, room) + after;
}

// The card redraws every 15 s while playing: keep recent artwork decoded instead of refetching it.
const ART_CACHE_SIZE = 50;
const artCache = new Map<string, Image>();

async function fetchArt(url: string): Promise<Image> {
  const hit = artCache.get(url);
  if (hit) return hit;
  // The track's source names this URL (an RSS feed can point it anywhere): web hosts only, and a size cap
  // so one huge "artwork" file can't run the bot out of memory.
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol) || u.hostname === 'localhost' || /^[\d.]+$|:/.test(u.hostname)) throw new Error('artwork host');
  const res = await fetch(u, { signal: AbortSignal.timeout(ART_TIMEOUT_MS) });
  if (!res.ok || !res.body) throw new Error(`artwork ${res.status}`);
  if (Number(res.headers.get('content-length') ?? 0) > ART_MAX_BYTES) throw new Error('artwork too big');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > ART_MAX_BYTES) throw new Error('artwork too big');
    chunks.push(chunk);
  }
  const img = await loadImage(Buffer.concat(chunks));
  artCache.set(url, img);
  if (artCache.size > ART_CACHE_SIZE) artCache.delete(artCache.keys().next().value!);
  return img;
}

/** A lighter shade for text and the knob, like the site's --accent-hot. */
function lighten(hex: string, amount = 0.18): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) + (255 - ((n >> shift) & 255)) * amount);
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}


/** Square crop; YouTube hq/sd thumbs are 4:3 with the 16:9 frame letterboxed inside, so skip the black bars. */
function crop(img: Image, url: string) {
  const h = /\/(hq|sd)default\./.test(url) ? img.width * 9 / 16 : img.height;
  const side = Math.min(img.width, h);
  return [(img.width - side) / 2, (img.height - side) / 2, side, side] as const;
}

/** Up to `max` lines, word-wrapped; the last one cut with … */
function wrap(ctx: SKRSContext2D, text: string, maxWidth: number, max: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i]!;
    if (ctx.measureText(next).width <= maxWidth || !cur) { cur = next; continue; }
    lines.push(cur);
    cur = words[i]!;
    if (lines.length === max - 1) { cur = words.slice(i).join(' '); break; }
  }
  lines.push(cur);
  return lines.slice(0, max).map(l => fit(ctx, l, maxWidth));
}

/** The cover, huge and blurred, darkened so text stays readable. */
function ambient(ctx: SKRSContext2D, img: Image, url: string, paused: boolean): void {
  ctx.save();
  ctx.filter = paused ? 'blur(48px) grayscale(0.7) brightness(0.55)' : 'blur(48px) saturate(1.3) brightness(0.8)';
  const [sx, sy, sw, sh] = crop(img, url);
  ctx.drawImage(img, sx, sy, sw, sh, -120, -W / 2 + H / 2 - 120, W + 240, W + 240);
  ctx.restore();
  const shade = ctx.createLinearGradient(0, 0, W, 0);
  shade.addColorStop(0, 'rgba(18, 17, 15, 0.25)');
  shade.addColorStop(0.45, 'rgba(18, 17, 15, 0.55)');
  shade.addColorStop(1, 'rgba(18, 17, 15, 0.82)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, W, H);
}

function drawArt(ctx: SKRSContext2D, img: Image | null, url: string | null, accent: string, paused: boolean): void {
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 14;
  ctx.fillStyle = C.bg;
  ctx.fillRect(PAD, PAD, ART, ART);
  ctx.restore();
  if (img && url) {
    ctx.save();
    if (paused) ctx.filter = 'grayscale(0.6) brightness(0.6)';
    ctx.drawImage(img, ...crop(img, url), PAD, PAD, ART, ART);
    ctx.restore();
  } else {
    const cx = PAD + ART / 2, cy = PAD + ART / 2;
    ctx.strokeStyle = C.faint;
    ctx.lineWidth = 2;
    for (const r of [110, 80, 50]) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); }
    ctx.fillStyle = accent;
    ctx.beginPath(); ctx.arc(cx, cy, 14, 0, Math.PI * 2); ctx.fill();
  }
  if (paused) {
    // Two pause bars on the cover
    const cx = PAD + ART / 2, cy = PAD + ART / 2;
    ctx.fillStyle = 'rgba(226, 219, 211, 0.92)';
    ctx.fillRect(cx - 26, cy - 34, 18, 68);
    ctx.fillRect(cx + 8, cy - 34, 18, 68);
  }
  ctx.strokeStyle = 'rgba(226, 219, 211, 0.12)';
  ctx.lineWidth = 2;
  ctx.strokeRect(PAD + 1, PAD + 1, ART - 2, ART - 2);
}

function equalizer(ctx: SKRSContext2D, x: number, baseline: number, color: string): number {
  ctx.fillStyle = color;
  [10, 18, 7, 14].forEach((h, i) => ctx.fillRect(x + i * 7, baseline - h, 4, h));
  return 40;
}

function chip(ctx: SKRSContext2D, label: string, right: number, y: number, color: string, hot: string): number {
  const h = 38, pad = 14;
  ctx.font = `19px ${MONO}`;
  ctx.letterSpacing = '1px';
  const w = ctx.measureText(label).width + pad * 2;
  const x = right - w;
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5);
  ctx.fillStyle = hot;
  ctx.fillText(label, x + pad, y + 26);
  return w;
}

export async function renderNowPlaying(np: NowPlayingImage): Promise<Buffer> {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const color = np.accent && /^#[0-9a-f]{6}$/i.test(np.accent) ? np.accent : C.accent;
  const hot = color === C.accent ? C.accentHot : lighten(color);
  const live = np.lengthMs <= 0;
  const [art, avatar] = await Promise.all([
    np.artworkUrl ? fetchArt(np.artworkUrl).catch(() => null) : null,
    np.requester?.avatarUrl ? fetchArt(np.requester.avatarUrl).catch(() => null) : null
  ]);

  ctx.fillStyle = C.panel;
  ctx.fillRect(0, 0, W, H);
  if (art) ambient(ctx, art, np.artworkUrl!, np.paused);
  // Accent line on top, like the site's panels
  ctx.fillStyle = np.paused ? C.faint : color;
  ctx.fillRect(0, 0, W, 4);

  drawArt(ctx, art, np.artworkUrl, color, np.paused);

  // Kicker: ▮▮▮ NOW PLAYING                         YOUTUBE
  ctx.textBaseline = 'alphabetic';
  const ky = PAD + 26;
  let kx = TX;
  if (!np.paused) kx += equalizer(ctx, TX, ky, hot);
  ctx.font = `22px ${MONO}`;
  ctx.letterSpacing = '4px';
  ctx.fillStyle = np.paused ? C.muted : hot;
  ctx.fillText(np.label.toLocaleUpperCase(np.locale), kx, ky);
  ctx.textAlign = 'right';
  ctx.fillStyle = C.muted;
  ctx.fillText(np.source.toUpperCase(), TX + TW, ky);
  ctx.textAlign = 'left';

  // Title (up to two lines) + artist
  const titleLocale = np.locale === 'tr' && /[çğıöşüÇĞİÖŞÜ]/.test(np.title) ? 'tr' : 'en';
  ctx.font = `bold 74px ${SANS}`;
  ctx.letterSpacing = '0.5px';
  ctx.fillStyle = np.paused ? C.muted : '#f3ede6';
  const lines = wrap(ctx, np.title.toLocaleUpperCase(titleLocale), TW, 2);
  let y = PAD + 112;
  for (const l of lines) { ctx.fillText(l, TX, y); y += 74; }
  if (np.artist) {
    ctx.font = `36px ${SANS}`;
    ctx.letterSpacing = '0px';
    ctx.fillStyle = C.muted;
    ctx.fillText(fit(ctx, np.artist, TW), TX, y - 14);
  }

  // Chips (right) first, so the requester (left) can use the room they leave
  const ry = H - PAD - 108;
  let right = TX + TW;
  for (const c of (np.chips ?? []).slice().reverse()) {
    const w = chip(ctx, c, right, ry + 4, np.paused ? C.faint : color, np.paused ? C.muted : hot);
    right -= w + 8;
    if (right < TX + 380) break;
  }
  if (np.requester) {
    const s = 46;
    if (avatar) {
      ctx.save();
      ctx.beginPath(); ctx.arc(TX + s / 2, ry + s / 2, s / 2, 0, Math.PI * 2); ctx.clip();
      ctx.drawImage(avatar, TX, ry, s, s);
      ctx.restore();
    }
    const nx = TX + (avatar ? s + 12 : 0);
    ctx.font = `17px ${MONO}`;
    ctx.letterSpacing = '2px';
    ctx.fillStyle = C.faint;
    if (np.requester.label) ctx.fillText(np.requester.label.toLocaleUpperCase(np.locale), nx, ry + 17);
    ctx.font = `bold 27px ${SANS}`;
    ctx.letterSpacing = '0.5px';
    ctx.fillStyle = C.text;
    // `right` is now the left edge of the chips (minus their 8 px gap)
    const room = Math.max(260, right + 8 - 24 - nx);
    const name = np.requester.title !== undefined
      ? fitSlot(ctx, np.requester.name, np.requester.title, room)
      : fit(ctx, np.requester.name, room);
    ctx.fillText(name, nx, ry + 45);
  }

  // Progress: 1:23  ━━━━━━━■──────────  3:34
  const by = H - PAD - 10;
  ctx.font = `24px ${MONO}`;
  ctx.letterSpacing = '1px';
  const now = live ? '' : clock(np.positionMs);
  const end = live ? np.liveLabel.toLocaleUpperCase(np.locale) : clock(np.lengthMs);
  const nowW = ctx.measureText(now || '0:00').width;
  const endW = ctx.measureText(end).width;
  ctx.fillStyle = C.text;
  if (now) ctx.fillText(now, TX, by + 8);
  ctx.textAlign = 'right';
  ctx.fillStyle = live ? hot : C.muted;
  ctx.fillText(end, TX + TW, by + 8);
  ctx.textAlign = 'left';
  const bx = TX + (live ? 0 : nowW + 20), bw = TW - (live ? 0 : nowW + 20) - endW - 20, bh = 8;
  const pct = live ? 1 : Math.min(1, Math.max(0, np.positionMs / np.lengthMs));
  ctx.fillStyle = 'rgba(226, 219, 211, 0.14)';
  ctx.fillRect(bx, by - bh / 2, bw, bh);
  if (pct > 0) {
    const g = ctx.createLinearGradient(bx, 0, bx + bw * pct, 0);
    g.addColorStop(0, np.paused ? C.faint : color);
    g.addColorStop(1, np.paused ? C.muted : hot);
    ctx.save();
    if (!np.paused) { ctx.shadowColor = color; ctx.shadowBlur = 14; }
    ctx.fillStyle = g;
    ctx.fillRect(bx, by - bh / 2, bw * pct, bh);
    ctx.restore();
  }
  if (!live) {
    const k = 20, kx2 = Math.min(bx + bw - k, Math.max(bx, bx + bw * pct - k / 2));
    ctx.save();
    if (!np.paused) { ctx.shadowColor = color; ctx.shadowBlur = 12; }
    ctx.fillStyle = np.paused ? C.muted : '#ffffff';
    ctx.fillRect(kx2, by - k / 2, k, k);
    ctx.restore();
  }
  return canvas.encode('png');
}
