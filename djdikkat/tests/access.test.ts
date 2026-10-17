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
