// Checks every translation in translations/ against English (en.json):
// same keys, same {placeholders}, nothing left empty, and in the website files
// the same HTML tags as English (the site prints those lines as HTML).
// Prints GitHub annotations; exits 1 when something has to be fixed.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'translations';
const SETS = ['bot', 'website'];
const NAME = /^[a-z]{2}(-[A-Z]{2})?\.json$/;
const UNSAFE = /<\s*(script|iframe|object|embed|style)|\son\w+\s*=|javascript:/i;

const holes = text => [...new Set(text.match(/\{\w+\}/g) ?? [])].sort().join(' ') || '(none)';
const tags = text => (text.match(/<\/?[a-z]+/gi) ?? []).map(t => t.toLowerCase()).sort().join(' ') || '(none)';
const files = set => readdirSync(join(ROOT, set)).filter(f => f.endsWith('.json'));

let errors = 0;
const error = (file, msg) => { errors++; console.log(`::error file=${file}::${msg}`); };
const warning = (file, msg) => console.log(`::warning file=${file}::${msg}`);

for (const set of SETS) {
  const en = JSON.parse(readFileSync(join(ROOT, set, 'en.json'), 'utf8'));
  for (const name of files(set).filter(f => f !== 'en.json')) {
    const file = join(ROOT, set, name);
    let data;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      error(file, `not valid JSON: ${err.message}`);
      continue;
    }
    if (!NAME.test(name)) error(file, 'name the file after the language code, like de.json or pt-BR.json');

    for (const [key, source] of Object.entries(en)) {
      const text = data[key];
      if (text === undefined) { error(file, `missing "${key}"`); continue; }
      if (typeof text !== 'string' || (!text.trim() && source.trim())) { error(file, `"${key}" is empty`); continue; }   // empty only where English is
      if (holes(text) !== holes(source)) error(file, `"${key}" must keep the placeholders ${holes(source)} (found ${holes(text)})`);
      if (set === 'website' && tags(text) !== tags(source)) error(file, `"${key}" must keep the same HTML tags as English: ${tags(source)} (found ${tags(text)})`);
      if (UNSAFE.test(text)) error(file, `"${key}" contains code that isn't allowed`);
    }
    for (const key of Object.keys(data)) {
      if (!(key in en)) error(file, `"${key}" isn't in en.json (a typo, or a line that was removed?)`);
    }
  }
}

// A language usually comes with both files; one alone is fine, but worth a note.
for (const name of new Set(SETS.flatMap(files))) {
  for (const set of SETS) {
    if (!files(set).includes(name)) warning(join(ROOT, set), `${name} is only in the other folder so far`);
  }
}

console.log(errors ? `\n${errors} thing(s) to fix, see the notes above.` : 'All translations match en.json.');
process.exit(errors ? 1 : 0);
