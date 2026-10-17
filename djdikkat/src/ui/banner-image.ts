/************************************************************
 * DJ DIKKAT - Music Bot
 * Banner images
 * The welcome card a server posts for new members, and the
 * launch banner. Same look as the now-playing card and the
 * website: warm dark, blue accent, square corners, film grain.
 * Author: Yanoee
 ************************************************************/
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { Image, SKRSContext2D } from '@napi-rs/canvas';
import { C, MONO, SANS, fit } from './np-image.ts';

const FETCH_TIMEOUT_MS = 4000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/**
 * Loads an image for a card. Admin-supplied URLs must be https on a real host name
 * (no IPs, no localhost) so the bot can't be pointed at its own machine.
 */
export async function loadRemote(url: string | null): Promise<Image | null> {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname === 'localhost' || /^[\d.]+$|:/.test(u.hostname)) return null;
    const res = await fetch(u, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) return null;
    if (Number(res.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > MAX_IMAGE_BYTES ? null : await loadImage(buf);
  } catch {
    return null;
  }
}

/** Film grain, like the website background. */
function grain(ctx: SKRSContext2D, w: number, h: number, amount = 0.05): void {
  for (let i = 0; i < (w * h) / 90; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? `rgba(255,255,255,${amount})` : `rgba(0,0,0,${amount * 1.6})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5);
  }
}

/** Draws img to cover the box (center crop). */
function cover(ctx: SKRSContext2D, img: Image, x: number, y: number, w: number, h: number): void {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale, sh = h / scale;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

function glow(ctx: SKRSContext2D, x: number, y: number, r: number, color: string, alpha: number): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, hexAlpha(color, alpha));
  g.addColorStop(1, hexAlpha(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

function hexAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// ── Welcome card ──────────────────────────────────────────

export interface WelcomeImage {
  kicker: string;          // "WELCOME" in the server's language
  name: string;            // the member's display name
  line: string;            // "Member #153 · OG Labs"
  avatarUrl: string;
  accent: string;          // #rrggbb
  background: string | null;
  locale: string;
}

const WW = 1100, WH = 400;

export async function renderWelcome(card: WelcomeImage): Promise<Buffer> {
  const canvas = createCanvas(WW, WH);
  const ctx = canvas.getContext('2d');
  const [bg, avatar] = await Promise.all([loadRemote(card.background), loadRemote(card.avatarUrl)]);

  // Background: the admin's picture under a dark veil, else the site's dark with a soft accent glow.
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, WW, WH);
  if (bg) {
    cover(ctx, bg, 0, 0, WW, WH);
    const veil = ctx.createLinearGradient(0, 0, WW, 0);
    veil.addColorStop(0, 'rgba(18,17,15,0.92)');
    veil.addColorStop(0.65, 'rgba(18,17,15,0.7)');
    veil.addColorStop(1, 'rgba(18,17,15,0.45)');
    ctx.fillStyle = veil;
    ctx.fillRect(0, 0, WW, WH);
  } else {
    const g = ctx.createLinearGradient(0, 0, WW, WH);
    g.addColorStop(0, C.panel);
    g.addColorStop(1, C.bg);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, WW, WH);
    glow(ctx, WW - 120, 40, 420, card.accent, 0.22);
    glow(ctx, 200, WH / 2, 260, card.accent, 0.12);
  }
  ctx.fillStyle = card.accent;
  ctx.fillRect(0, 0, 8, WH);
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, WW - 2, WH - 2);

  // Avatar in a ring
  const AX = 200, AY = WH / 2, AR = 112;
  ctx.strokeStyle = hexAlpha(card.accent, 0.25);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(AX, AY, AR + 22, 0, Math.PI * 2);
  ctx.stroke();
  ctx.save();
  ctx.beginPath();
  ctx.arc(AX, AY, AR, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = C.panel;
  ctx.fillRect(AX - AR, AY - AR, AR * 2, AR * 2);
  if (avatar) ctx.drawImage(avatar, AX - AR, AY - AR, AR * 2, AR * 2);
  ctx.restore();
  ctx.strokeStyle = card.accent;
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(AX, AY, AR + 4, 0, Math.PI * 2);
  ctx.stroke();

  // Text column
  const TX = 380, TW = WW - TX - 60;
  ctx.textBaseline = 'alphabetic';
  ctx.letterSpacing = '8px';
  ctx.font = `26px ${MONO}`;
  ctx.fillStyle = card.accent;
  ctx.fillText(card.kicker.toLocaleUpperCase(card.locale), TX, 150);

  ctx.letterSpacing = '1px';
  ctx.font = `bold 92px ${SANS}`;
  ctx.fillStyle = C.text;
  ctx.fillText(fit(ctx, card.name, TW), TX, 245);

  ctx.fillStyle = card.accent;
  ctx.fillRect(TX, 272, 64, 4);

  ctx.letterSpacing = '2px';
  ctx.font = `24px ${MONO}`;
  ctx.fillStyle = C.muted;
  ctx.fillText(fit(ctx, card.line, TW), TX, 318);

  ctx.letterSpacing = '4px';
  ctx.font = `15px ${MONO}`;
  ctx.fillStyle = C.faint;
  ctx.textAlign = 'right';
  ctx.fillText('DJ DIKKAT', WW - 28, WH - 24);
  ctx.textAlign = 'left';

  grain(ctx, WW, WH);
  return canvas.encode('png');
}

// ── Launch banner ─────────────────────────────────────────

const LW = 1200, LH = 500;

/** Texts come translated (the banner always matches the message's language). */
export interface LaunchImage { kicker: string; tagline: string; chips: string[]; locale: string }

export async function renderLaunch(text: LaunchImage): Promise<Buffer> {
  const canvas = createCanvas(LW, LH);
  const ctx = canvas.getContext('2d');

  const g = ctx.createLinearGradient(0, 0, LW, LH);
  g.addColorStop(0, C.panel);
  g.addColorStop(1, C.bg);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, LW, LH);
  glow(ctx, 930, 250, 420, C.accent, 0.28);
  glow(ctx, 120, 60, 300, '#b5651d', 0.1);

  // Faint grid, like a mixing desk
  ctx.strokeStyle = 'rgba(226,219,211,0.035)';
  ctx.lineWidth = 1;
  for (let x = 0; x < LW; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, LH); ctx.stroke(); }
  for (let y = 0; y < LH; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(LW, y); ctx.stroke(); }

  // Record on the right
  const RX = 930, RY = 250;
  ctx.fillStyle = '#0c0b0a';
  ctx.beginPath();
  ctx.arc(RX, RY, 190, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1.5;
  for (let r = 70; r < 186; r += 9) {
    ctx.strokeStyle = `rgba(226,219,211,${r % 2 ? 0.05 : 0.09})`;
    ctx.beginPath();
    ctx.arc(RX, RY, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = C.accent;
  ctx.beginPath();
  ctx.arc(RX, RY, 62, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0c0b0a';
  ctx.beginPath();
  ctx.arc(RX, RY, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(RX, RY, 150, -2.4, -1.6);
  ctx.stroke();

  ctx.fillStyle = C.accent;
  ctx.fillRect(0, 0, 10, LH);

  const TX = 70;
  ctx.textBaseline = 'alphabetic';
  ctx.letterSpacing = '7px';
  ctx.font = `24px ${MONO}`;
  ctx.fillStyle = C.accentHot;
  ctx.fillText(text.kicker.toLocaleUpperCase(text.locale), TX, 120);

  ctx.letterSpacing = '2px';
  ctx.font = `bold 150px ${SANS}`;
  ctx.fillStyle = C.text;
  ctx.fillText('DJ', TX, 262);
  const dj = ctx.measureText('DJ ').width;
  ctx.fillStyle = C.accent;
  ctx.fillText('DIKKAT', TX + dj, 262);

  ctx.letterSpacing = '0.5px';
  // Shrink a long tagline (Turkish runs longer) so it stays clear of the record.
  let size = 34;
  do ctx.font = `${size}px ${SANS}`; while (ctx.measureText(text.tagline).width > 640 && --size > 24);
  ctx.fillStyle = C.text;
  ctx.fillText(fit(ctx, text.tagline, 640), TX, 322);

  // Feature chips
  ctx.letterSpacing = '3px';
  ctx.font = `17px ${MONO}`;
  let x = TX;
  let y = 372;
  for (const chip of text.chips.map(c => c.toLocaleUpperCase(text.locale))) {
    const w = ctx.measureText(chip).width + 32;
    if (x + w > 760) { x = TX; y += 54; }
    ctx.fillStyle = 'rgba(59,130,196,0.12)';
    ctx.fillRect(x, y, w, 40);
    ctx.strokeStyle = 'rgba(59,130,196,0.55)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 0.75, y + 0.75, w - 1.5, 38.5);
    ctx.fillStyle = '#cfe4f7';
    ctx.fillText(chip, x + 16, y + 26);
    x += w + 12;
  }

  grain(ctx, LW, LH, 0.045);
  return canvas.encode('png');
}
