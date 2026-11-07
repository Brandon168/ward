#!/bin/sh
# Regenerates public_suffix_list.js from public_suffix_list.dat: the rules only, already in the form Ward looks them up
# in (ASCII via IDNA, as URL does, lowercase, no trailing dot) and split into exact, wildcard (*.) and exception (!)
# rules, so a popup or service worker builds its lookup sets without parsing anything. Needs Node.
# usage: vendor/psl.sh <list date, e.g. 2026-10-20>
set -eu
cd "$(dirname "$0")"
node --input-type=module - "$1" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const date = process.argv[2];
const ascii = (body) => { try { return new URL(`https://${body}`).hostname.toLowerCase().replace(/\.$/, ''); } catch { return body.toLowerCase(); } };
const out = { exact: [], wildcard: [], exception: [] };
for (const line of readFileSync('public_suffix_list.dat', 'utf8').split('\n')) {
  const raw = line.trim().split(/\s/)[0]; // one rule per line, up to the first whitespace; comments start with //
  if (!raw || raw.startsWith('//')) continue;
  if (raw.startsWith('!')) out.exception.push(ascii(raw.slice(1)));
  else if (raw.startsWith('*.')) out.wildcard.push(ascii(raw.slice(2)));
  else out.exact.push(ascii(raw));
}
const list = (name, rules) => `export const ${name} = \`\n${rules.join('\n')}\n\`;\n`;
writeFileSync('public_suffix_list.js', `// Generated from public_suffix_list.dat by psl.sh (Public Suffix List ${date}, MPL 2.0): https://publicsuffix.org/list/\n`
  + `// and https://mozilla.org/MPL/2.0/. Rules in lookup form: ASCII (IDNA), lowercase; exact, wildcard (*.) and exception (!).\n`
  + `export const PSL_DATE = '${date}';\n` + list('PSL_EXACT', out.exact) + list('PSL_WILDCARD', out.wildcard) + list('PSL_EXCEPTION', out.exception));
JS
