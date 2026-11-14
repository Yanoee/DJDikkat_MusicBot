// Speakable names — `npm test`. What the Radio Host may say out loud for a
// requester: plain letters, no noise, and null for empty or rude names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGuildMemory } from '../src/services/memory.ts';
import { defaultFeatures } from '../src/services/features.ts';
import { speakableName } from '../src/services/speakable.ts';

const GUILD = '100000000000000077';

test('fancy fonts become plain letters', () => {
  assert.equal(speakableName('𝓑𝓮𝓷𝓭𝓮𝓻'), 'Bender');
  assert.equal(speakableName('ｂｅｎｄｅｒ'), 'bender');
  assert.equal(speakableName('ʙᴇɴᴅᴇʀ'), 'bender');
  assert.equal(speakableName('Ⓑⓔⓝⓓⓔⓡ'), 'Bender');
  assert.equal(speakableName('Z̷̢̛a̴l̶g̵o̷ Bender'), 'Zalgo Bender');
});

test('emojis, symbols, links, mentions and tags go', () => {
  assert.equal(speakableName('🔥Bender🔥'), 'Bender');
  assert.equal(speakableName('✿ Melis ✿'), 'Melis');
  assert.equal(speakableName('Selin ❤️'), 'Selin');
  assert.equal(speakableName('xX_Bender_Xx'), 'Bender');
  assert.equal(speakableName('...Bender...'), 'Bender');
  assert.equal(speakableName('bender#1234'), 'bender');
  assert.equal(speakableName('bender.official'), 'bender official');
  assert.equal(speakableName('@everyone Bender'), 'Bender');
  assert.equal(speakableName('https://twitch.tv/bender Bender'), 'Bender');
  assert.equal(speakableName('Benderrrrrr'), 'Benderr');
  assert.equal(speakableName('Bender2005'), 'Bender');
});

test('clan tags in brackets are dropped', () => {
  assert.equal(speakableName('[OG] Bender'), 'Bender');
  assert.equal(speakableName('【ＴＲ】Bender'), 'Bender');
  assert.equal(speakableName('Bender (TTV)'), 'Bender');
  assert.equal(speakableName('[Bender]'), 'Bender');
});

test('Turkish names and normal accents stay intact', () => {
  assert.equal(speakableName('Çağrı'), 'Çağrı');
  assert.equal(speakableName('Işıl'), 'Işıl');
  assert.equal(speakableName('IŞIL'), 'Işıl');
  assert.equal(speakableName('Işık'), 'Işık');                 // holds "sik" when folded, still fine
  assert.equal(speakableName('İrem Şahin'), 'İrem Şahin');
  assert.equal(speakableName('Gökçe_Ünal'), 'Gökçe Ünal');
  assert.equal(speakableName('Beyoncé'), 'Beyoncé');
  assert.equal(speakableName("D'Angelo"), "D'Angelo");
  for (const name of ['Ramazan', 'Kamil', 'Amine', 'Hitchcock', 'Sussex']) assert.equal(speakableName(name), name);
});

test('long names are cut at a word', () => {
  assert.equal(speakableName('Bartholomew Fitzgerald Montgomery'), 'Bartholomew Fitzgerald');
  assert.equal(speakableName('The Amazing Spider-Man Fan'), 'The Amazing Spider-Man');
  assert.ok(speakableName('Supercalifragilisticexpialidocious')!.length <= 24);
});

test('nothing sayable, digits only or one letter → null', () => {
  for (const name of ['1234567', '', '   ', 'a', 'aaaa', '-_-', 'ʕ•ᴥ•ʔ', '🔥🔥🔥', 'Бендер', 'a1234']) {
    assert.equal(speakableName(name), null, name);
  }
});

test('insults are rejected in both languages, leetspeak and spaced too', () => {
  for (const name of [
    'fuck', 'FuUuCk', 'f.u.c.k', 'b1tch', 'N1gg3r', 'xXsh1tXx', 'pornhub.com',
    'orospu', '0r0spu', 'o r o s p u', 's1kt1r', 'Ali s i k', '4mk', 'yarrrak', 'piç', 'Şerefsiz', '[s1k] Ali'
  ]) assert.equal(speakableName(name), null, name);
});

test("inflected and spelled-around insults are caught (review 2026-11-14)", () => {
  for (const name of [
    "dickhead", "wanker", "cocksucker", "fcuk", "skank", "Kill Yourself", "ipne", "yarrağım", "siktiğim",
    "bok", "piçkurusu", "salaksın", "götoş", "sikko", "orsbu", "0rspu", "Ali oro spu"
  ]) assert.equal(speakableName(name), null, name);
});

test("common names stay, also when two names join into a bad word", () => {
  for (const name of [
    "Sıla", "Kerem", "Ayşegül", "Ozan", "Pınar", "Göktuğ", "Fatma", "Kaşif", "Bob", "Malik", "Cumali",
    "Heidi Otto", "Işık Işık", "Yar Akın", "Jack Asher", "Ewan Kerr"
  ]) assert.equal(speakableName(name), name);
});

test("the server's AutoMod keywords are rejected too", () => {
  const features = defaultFeatures();
  features.words.words = ['kartoffel', 'banan*', '*zilla', '*bozuk*'];
  getGuildMemory(GUILD).settings.features = features;
  const guild = { id: GUILD };
  assert.equal(speakableName('Kartoffel', guild), null);
  assert.equal(speakableName('K4rt0ffel Ali', guild), null);
  assert.equal(speakableName('Bananaman', guild), null);
  assert.equal(speakableName('Godzilla', guild), null);
  assert.equal(speakableName('superbozukadam', guild), null);
  assert.equal(speakableName('Kartoffelsalat', guild), 'Kartoffelsalat');   // whole word only
  assert.equal(speakableName('Kartoffel'), 'Kartoffel');                     // other servers don't care
  assert.equal(speakableName('Bender', guild), 'Bender');
});
