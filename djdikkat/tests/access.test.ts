// Panel access levels — `npm test`. Manage Server always wins; a member grant or
// any of the member's roles sets the level, and level 1 beats level 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { getGuildMemory } from '../src/services/memory.ts';
import { panelLevel } from '../src/services/access.ts';
import type { GuildPermissions } from '../src/services/access.ts';

const GUILD = '100000000000000001';
const member = (id: string, roles: string[], manager = false) => ({
  id, guild: { id: GUILD },
  roles: { cache: new Map(roles.map(r => [r, {}])) },
  permissions: { has: (flag: bigint) => manager && flag === PermissionFlagsBits.ManageGuild }
}) as never;

test('panel levels: admin, grants by member and role, highest wins, nothing otherwise', () => {
  getGuildMemory(GUILD).settings.permissions = {
    djRoles: [], textChannels: [], voiceChannels: [], commands: {},
    panel: [{ type: 'role', id: 'djrole', level: 2 }, { type: 'role', id: 'modrole', level: 1 }, { type: 'user', id: 'u-full', level: 1 }, { type: 'user', id: 'u-dj', level: 2 }]
  } satisfies GuildPermissions;
  assert.equal(panelLevel(member('anyone', [], true)), 'admin');
  assert.equal(panelLevel(member('u-full', [])), 'full');
  assert.equal(panelLevel(member('u-dj', [])), 'dj');
  assert.equal(panelLevel(member('x', ['djrole'])), 'dj');
  assert.equal(panelLevel(member('x', ['djrole', 'modrole'])), 'full');
  assert.equal(panelLevel(member('u-dj', ['modrole'])), 'full');
  assert.equal(panelLevel(member('x', ['other'])), null);
});

// Normal mode: everyone plays/pauses, DJ for the rest; alone in voice or your own song (skip) passes.
import { denial, normalPermissions } from '../src/services/access.ts';
import { getState } from '../src/music/state.ts';

const VOICE = { id: 'vc', humans: 2 };
const voiceMember = (id: string, roles: string[], opts: { manager?: boolean; inVoice?: boolean } = {}) => ({
  id,
  guild: { id: GUILD, members: { me: { voice: { channel: { id: VOICE.id, members: { filter: () => ({ size: VOICE.humans }) } } } } } },
  roles: { cache: new Map(roles.map(r => [r, {}])) },
  permissions: { has: (flag: bigint) => !!opts.manager && flag === PermissionFlagsBits.ManageGuild },
  voice: { channelId: opts.inVoice === false ? null : VOICE.id }
}) as never;

test('normal mode: DJ keys need the role, the rest is open; own song, alone, admins and no-role pass', () => {
  getGuildMemory(GUILD).settings.permissions = normalPermissions('djrole');
  getState(GUILD).current = { requesterId: 'adder' } as never;
  VOICE.humans = 2;
  const user = voiceMember('user', []);
  for (const key of ['play', 'playlist', 'pause', 'queue', 'history', 'stats'] as const) assert.equal(denial(user, key, null), null, key);
  for (const key of ['skip', 'stop', 'disconnect', 'loop', 'shuffle', 'filter', 'autoplay', 'clear'] as const) assert.equal(denial(user, key, null)?.key, 'perm.role', key);
  assert.equal(denial(voiceMember('adder', []), 'skip', null), null);                 // their own song
  assert.equal(denial(voiceMember('adder', []), 'stop', null)?.key, 'perm.role');     // but not stop
  assert.equal(denial(voiceMember('dj', ['djrole']), 'stop', null), null);
  assert.equal(denial(voiceMember('boss', [], { manager: true }), 'disconnect', null), null);
  VOICE.humans = 1;
  assert.equal(denial(user, 'stop', null), null);                                      // alone with the bot
  assert.equal(denial(voiceMember('away', [], { inVoice: false }), 'stop', null)?.key, 'perm.role');
  VOICE.humans = 2;
  getGuildMemory(GUILD).settings.permissions = normalPermissions(null);
  assert.equal(denial(user, 'stop', null), null);                                      // no DJ role yet: nobody locked out
});
