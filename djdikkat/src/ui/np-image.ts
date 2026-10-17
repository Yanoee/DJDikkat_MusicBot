/************************************************************
 * DJ DIKKAT - Music Bot
 * Now-playing image
 * Draws the player card as a PNG in the website's rust
 * theme (warm dark, the server's accent, square corners): the
 * song's colour washed behind it, a glowing progress bar,
 * the requester's chip and the site's film grain.
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

const W = 1000, H = 280, PAD = 32, ART = H - PAD * 2;
const TX = PAD + ART + 36, TW = W - TX - PAD;   // text column
const ART_TIMEOUT_MS = 3000;

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
  requester?: { name: string; avatarUrl: string | null } | null;   // chip in the top right
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

// The card redraws every 15 s while playing: keep recent artwork decoded instead of refetching it.
const ART_CACHE_SIZE = 50;
const artCache = new Map<string, Image>();

async function fetchArt(url: string): Promise<Image> {
  const hit = artCache.get(url);
  if (hit) return hit;
  const res = await fetch(url, { signal: AbortSignal.timeout(ART_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`artwork ${res.status}`);
  const img = await loadImage(Buffer.from(await res.arrayBuffer()));
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

/** One flat colour from the artwork (its average), washed from the left into the dark panel. No picture. */
function backdrop(ctx: SKRSContext2D, img: Image, url: string): void {
  const dot = createCanvas(1, 1);
  const dctx = dot.getContext('2d');
  dctx.drawImage(img, ...crop(img, url), 0, 0, 1, 1);
  const [r, g, b] = dctx.getImageData(0, 0, 1, 1).data;
  const wash = ctx.createLinearGradient(0, 0, W, 0);
  wash.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.42)`);
  wash.addColorStop(0.55, `rgba(${r}, ${g}, ${b}, 0.14)`);
  wash.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, W, H);
}

function glow(ctx: SKRSContext2D, x: number, y: number, r: number, color: string, alpha: number): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  ctx.globalAlpha = alpha;
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.globalAlpha = 1;
}

function drawArt(ctx: SKRSContext2D, img: Image | null, url: string | null, accent: string, paused: boolean): void {
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 10;
  ctx.fillStyle = C.bg;
  ctx.fillRect(PAD, PAD, ART, ART);
  ctx.restore();
  if (img && url) {
    ctx.drawImage(img, ...crop(img, url), PAD, PAD, ART, ART);
    if (paused) {
      ctx.fillStyle = 'rgba(18, 17, 15, 0.5)';
      ctx.fillRect(PAD, PAD, ART, ART);
    }
  } else {
    // Vinyl placeholder (fonts have no ♪ glyph)
    const cx = PAD + ART / 2, cy = PAD + ART / 2;
    ctx.strokeStyle = C.faint;
    ctx.lineWidth = 2;
    for (const r of [72, 52, 32]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(226, 219, 211, 0.14)';
  ctx.lineWidth = 2;
  ctx.strokeRect(PAD + 1, PAD + 1, ART - 2, ART - 2);
}

/** Little equalizer bars while playing, two pause bars while paused. Returns the width used. */
function meter(ctx: SKRSContext2D, x: number, baseline: number, color: string, paused: boolean): number {
  ctx.fillStyle = color;
  if (paused) {
    ctx.fillRect(x, baseline - 15, 4, 15);
    ctx.fillRect(x + 8, baseline - 15, 4, 15);
    return 22;
  }
  [9, 15, 6, 12].forEach((h, i) => ctx.fillRect(x + i * 6, baseline - h, 4, h));
  return 34;
}

/** Requester chip, top right: avatar + name. */
function requesterChip(ctx: SKRSContext2D, name: string, avatar: Image | null): void {
  const h = 30, pad = 10, right = W - PAD;
  ctx.font = `17px ${MONO}`;
  ctx.letterSpacing = '1px';
  const label = fit(ctx, name, 220);
  const w = (avatar ? h : 0) + pad * 2 + ctx.measureText(label).width;
  const x = right - w, y = PAD - 6;
  ctx.fillStyle = 'rgba(226, 219, 211, 0.08)';
  ctx.fillRect(x, y, w, h);
  if (avatar) ctx.drawImage(avatar, x, y, h, h);
  ctx.fillStyle = C.text;
  ctx.fillText(label, x + (avatar ? h : 0) + pad, y + 21);
}

export async function renderNowPlaying(np: NowPlayingImage): Promise<Buffer> {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const color = np.accent && /^#[0-9a-f]{6}$/i.test(np.accent) ? np.accent : C.accent;
  const hot = color === C.accent ? C.accentHot : lighten(color);
  const accent = np.paused ? C.faint : color;
  const live = np.lengthMs <= 0;
  const [art, avatar] = await Promise.all([
    np.artworkUrl ? fetchArt(np.artworkUrl).catch(() => null) : null,
    np.requester?.avatarUrl ? fetchArt(np.requester.avatarUrl).catch(() => null) : null
  ]);

  // Background: the song's own colour, a glow of the server's colour behind the cover, the site's grid
  ctx.fillStyle = C.panel;
  ctx.fillRect(0, 0, W, H);
  if (art) backdrop(ctx, art, np.artworkUrl!);
  if (!np.paused) glow(ctx, PAD + ART / 2, PAD + ART / 2, 260, color, 0.22);
  ctx.strokeStyle = 'rgba(226, 219, 211, 0.03)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, 6, H);

  drawArt(ctx, art, np.artworkUrl, color, np.paused);

  // Meter + label · source, requester on the right
  ctx.textBaseline = 'alphabetic';
  const mw = meter(ctx, TX, PAD + 20, np.paused ? C.muted : hot, np.paused);
  ctx.letterSpacing = '3px';
  ctx.font = `18px ${MONO}`;
  ctx.fillStyle = np.paused ? C.muted : hot;
  const label = np.label.toLocaleUpperCase(np.locale);
  ctx.fillText(label, TX + mw, PAD + 20);
  const labelW = ctx.measureText(label).width;
  ctx.fillStyle = C.muted;
  ctx.fillText(fit(ctx, ` · ${np.source.toUpperCase()}`, TW - mw - labelW - (np.requester ? 250 : 0)), TX + mw + labelW, PAD + 20);
  if (np.requester) requesterChip(ctx, np.requester.name, avatar);

  // Title + artist
  // Turkish casing (i → İ) only for Turkish-looking titles, so "Straight" doesn't become "STRAİGHT"
  const titleLocale = np.locale === 'tr' && /[çğıöşüÇĞİÖŞÜ]/.test(np.title) ? 'tr' : 'en';
  ctx.letterSpacing = '0.5px';
  ctx.font = `bold 48px ${SANS}`;
  ctx.fillStyle = np.paused ? C.muted : C.text;
  ctx.fillText(fit(ctx, np.title.toLocaleUpperCase(titleLocale), TW), TX, PAD + 86);
  if (np.artist) {
    ctx.letterSpacing = '0px';
    ctx.font = `28px ${SANS}`;
    ctx.fillStyle = C.muted;
    ctx.fillText(fit(ctx, np.artist, TW), TX, PAD + 128);
  }

  // Progress bar: gradient fill with a soft glow, square knob like the site's buttons
  const barY = H - PAD - 54, barH = 10;
  const pct = live ? 1 : Math.min(1, Math.max(0, np.positionMs / np.lengthMs));
  ctx.fillStyle = 'rgba(226, 219, 211, 0.1)';
  ctx.fillRect(TX, barY, TW, barH);
  if (pct > 0) {
    const fill = ctx.createLinearGradient(TX, 0, TX + TW * pct, 0);
    fill.addColorStop(0, accent);
    fill.addColorStop(1, np.paused ? C.muted : hot);
    ctx.save();
    if (!np.paused) { ctx.shadowColor = color; ctx.shadowBlur = 16; }
    ctx.fillStyle = fill;
    ctx.fillRect(TX, barY, TW * pct, barH);
    ctx.restore();
  }
  if (!live) {
    const k = 20, kx = Math.min(TX + TW - k, Math.max(TX, TX + TW * pct - k / 2));
    ctx.save();
    if (!np.paused) { ctx.shadowColor = color; ctx.shadowBlur = 14; }
    ctx.fillStyle = np.paused ? C.muted : '#ffffff';
    ctx.fillRect(kx, barY + barH / 2 - k / 2, k, k);
    ctx.restore();
  }

  // Times
  ctx.font = `20px ${MONO}`;
  ctx.letterSpacing = '1px';
  ctx.fillStyle = C.text;
  ctx.fillText(live ? '' : clock(np.positionMs), TX, H - PAD - 6);
  ctx.textAlign = 'right';
  ctx.fillStyle = live ? hot : C.muted;
  ctx.fillText(live ? np.liveLabel.toLocaleUpperCase(np.locale) : clock(np.lengthMs), TX + TW, H - PAD - 6);
  ctx.textAlign = 'left';

  // Film grain, like the website background
  for (let i = 0; i < (W * H) / 90; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? 'rgba(255, 255, 255, 0.035)' : 'rgba(0, 0, 0, 0.06)';
    ctx.fillRect(Math.random() * W, Math.random() * H, 1.5, 1.5);
  }
  return canvas.encode('png');
}
