/************************************************************
 * DJ DIKKAT - Music Bot
 * Member greeting
 * Optional message when someone joins a server, written in the
 * web panel's editor: in a channel (Discord's system channel
 * unless one is picked), as a DM, or both; as text, an image
 * card, or both. Off until a server turns it on. Needs the
 * Server Members intent (index.ts asks for it only when the
 * Developer Portal allows it).
 * Author: Yanoee
 ************************************************************/
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { Guild, GuildMember, MessageCreateOptions } from 'discord.js';
import { getGuildMemory, setGuildSettings } from './memory.ts';
import { TEXT_TYPES } from './access.ts';
import { guildLocale } from './locale.ts';
import { renderWelcome } from '../ui/banner-image.ts';
import { t } from '../i18n/index.ts';
import { errMsg } from '../lib/errors.ts';
import { config } from '../config.ts';

export interface WelcomeEmbed {
  enabled: boolean;
  title: string;
  description: string;
  color: string;      // #rrggbb
  thumbnail: boolean; // the member's avatar
  image: string;      // https URL or ''
  footer: string;
}

export interface WelcomeConfig {
  enabled: boolean;
  toChannel: boolean;
  channelId: string | null;   // null = Discord's system channel
  dm: boolean;                // send it to the new member privately
  style: 'text' | 'image' | 'both';
  text: string;               // message above the card (may be '')
  embed: WelcomeEmbed;
  card: { accent: string; background: string };  // image card
  button: boolean;            // "Check out the bot" link under the greeting
}

const LIMITS = { text: 2000, title: 256, description: 4096, footer: 2048, image: 500 };
const GAP_MS = 2000; // a join raid gets one greeting every 2s per server, the rest are skipped
const lastSent = new Map<string, number>();
const COLOR = /^#[0-9a-f]{6}$/i;

export const defaultWelcome = (): WelcomeConfig => ({
  enabled: false, toChannel: true, channelId: null, dm: false, style: 'image', text: '',
  embed: { enabled: false, title: '', description: '', color: '#3b82c4', thumbnail: true, image: '', footer: '' },
  card: { accent: '#3b82c4', background: '' },
  button: true
});

export function getWelcome(guildId: string): WelcomeConfig {
  const saved = getGuildMemory(guildId).settings.welcome;
  const base = defaultWelcome();
  return saved ? { ...base, ...saved, embed: { ...base.embed, ...saved.embed }, card: { ...base.card, ...saved.card } } : base;
}

const str = (v: unknown, max: number) => typeof v === 'string' ? v.slice(0, max) : '';
const httpsUrl = (v: unknown) => {
  const s = str(v, LIMITS.image).trim();
  return /^https:\/\/\S+$/.test(s) ? s : '';
};

/** Keeps known fields within Discord's limits; the channel must be a text channel of this guild. */
export function sanitizeWelcome(guild: Guild, input: unknown): WelcomeConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const e = (raw.embed && typeof raw.embed === 'object' ? raw.embed : {}) as Record<string, unknown>;
  const c = (raw.card && typeof raw.card === 'object' ? raw.card : {}) as Record<string, unknown>;
  const channelId = typeof raw.channelId === 'string' && TEXT_TYPES.includes(guild.channels.cache.get(raw.channelId)?.type as never)
    ? raw.channelId : null;
  return {
    enabled: raw.enabled === true,
    toChannel: raw.toChannel !== false,
    channelId,
    dm: raw.dm === true,
    style: raw.style === 'text' || raw.style === 'both' ? raw.style : 'image',
    text: str(raw.text, LIMITS.text),
    embed: {
      enabled: e.enabled === true,
      title: str(e.title, LIMITS.title),
      description: str(e.description, LIMITS.description),
      color: typeof e.color === 'string' && COLOR.test(e.color) ? e.color.toLowerCase() : '#3b82c4',
      thumbnail: e.thumbnail !== false,
      image: httpsUrl(e.image),
      footer: str(e.footer, LIMITS.footer)
    },
    card: {
      accent: typeof c.accent === 'string' && COLOR.test(c.accent) ? c.accent.toLowerCase() : '#3b82c4',
      background: httpsUrl(c.background)
    },
    button: raw.button !== false
  };
}

export function saveWelcome(guildId: string, welcome: WelcomeConfig): void {
  setGuildSettings(guildId, { welcome });
}

/** Where the channel post goes: the picked channel, else Discord's system channel. */
export function welcomeChannelId(w: WelcomeConfig, guild: Guild): string | null {
  return w.channelId ?? guild.systemChannelId;
}

/** A setting problem the panel should show before saving, or null. */
export function welcomeProblem(w: WelcomeConfig, guild: Guild): string | null {
  if (!w.toChannel && !w.dm) return 'welcome_target';
  if (w.toChannel && !welcomeChannelId(w, guild)) return 'welcome_channel';
  const hasCard = w.style !== 'text';
  const hasEmbed = w.style !== 'image' && w.embed.enabled && !!(w.embed.title.trim() || w.embed.description.trim() || w.embed.image);
  return !w.text.trim() && !hasCard && !hasEmbed ? 'welcome_empty' : null;
}

/** {user} {user.name} {user.tag} {server} {memberCount} {date} */
function fill(text: string, member: GuildMember): string {
  const vars: Record<string, string> = {
    'user': `<@${member.id}>`,
    'user.name': member.displayName,
    'user.tag': member.user.username,
    'server': member.guild.name,
    'memberCount': String(member.guild.memberCount),
    'date': `<t:${Math.floor(Date.now() / 1000)}:D>`
  };
  return text.replace(/\{(user\.name|user\.tag|user|server|memberCount|date)\}/g, (_m, name: string) => vars[name]!);
}

/** The image card for this member, in the server's language. */
export function renderCard(w: WelcomeConfig, member: GuildMember): Promise<Buffer> {
  const locale = guildLocale(member.guild.id, member.guild);
  return renderWelcome({
    kicker: t(locale, 'welcome.card.kicker'),
    name: member.displayName,
    line: t(locale, 'welcome.card.line', { number: member.guild.memberCount, server: member.guild.name }),
    avatarUrl: member.displayAvatarURL({ extension: 'png', size: 256 }),
    accent: w.card.accent,
    background: w.card.background || null,
    locale
  });
}

/** The greeting for this member. Only the member may be pinged: never @everyone, @here or roles. */
export async function buildGreeting(w: WelcomeConfig, member: GuildMember): Promise<MessageCreateOptions> {
  const out: MessageCreateOptions = { allowedMentions: { parse: [], users: [member.id] } };
  if (w.text.trim()) out.content = fill(w.text, member);
  const withImage = w.style !== 'text';
  if (withImage) out.files = [new AttachmentBuilder(await renderCard(w, member), { name: 'welcome.png' })];
  if (w.style !== 'image' && w.embed.enabled) {
    const embed = new EmbedBuilder().setColor(parseInt(w.embed.color.slice(1), 16));
    if (w.embed.title.trim()) embed.setTitle(fill(w.embed.title, member).slice(0, LIMITS.title));
    if (w.embed.description.trim()) embed.setDescription(fill(w.embed.description, member).slice(0, LIMITS.description));
    // With the picture card the embed stays plain: no avatar thumbnail (the card has it), no image inside.
    if (w.embed.thumbnail && !withImage) embed.setThumbnail(member.displayAvatarURL({ size: 256 }));
    if (w.embed.image && !withImage) embed.setImage(w.embed.image);
    if (w.embed.footer.trim()) embed.setFooter({ text: fill(w.embed.footer, member).slice(0, LIMITS.footer) });
    out.embeds = [embed];
  }
  if (w.button) {
    const locale = guildLocale(member.guild.id, member.guild);
    out.components = [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(locale, 'welcome.button')).setEmoji('🎵').setURL(config.publicUrl)
    )];
  }
  return out;
}

/** Sends the greeting where it's set up. Returns an error code, or null when sent. */
export async function sendGreeting(w: WelcomeConfig, member: GuildMember): Promise<string | null> {
  const problem = welcomeProblem(w, member.guild);
  if (problem) return problem;
  const message = await buildGreeting(w, member);
  if (w.toChannel) {
    const channel = member.guild.channels.cache.get(welcomeChannelId(w, member.guild) ?? '');
    if (!channel?.isSendable()) return 'welcome_channel';
    try {
      await channel.send(message);
    } catch (err) {
      console.warn(`[WELCOME] guild=${member.guild.id} send failed: ${errMsg(err)}`);
      return 'cannot_send';
    }
  }
  if (w.dm) {
    const dmOk = await member.send({ ...message, allowedMentions: { parse: [] } }).then(() => true, () => false);
    if (!w.toChannel && !dmOk) return 'dm_closed';
  }
  return null;
}

/** GuildMemberAdd: greet when this server turned it on. */
export async function onMemberJoin(member: GuildMember): Promise<void> {
  if (member.user.bot) return;
  const w = getWelcome(member.guild.id);
  if (!w.enabled) return;
  const now = Date.now();
  if (now - (lastSent.get(member.guild.id) ?? 0) < GAP_MS) return;
  lastSent.set(member.guild.id, now);
  const failed = await sendGreeting(w, member);
  console.debug(`[WELCOME] guild=${member.guild.id} member=${member.id} ${failed ?? 'sent'}`);
}
