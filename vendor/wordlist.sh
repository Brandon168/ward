#!/bin/sh
# Regenerates eff_large_wordlist.js from eff_large_wordlist.txt: the 7,776 words, one per line, without the dice numbers.
# Source: https://www.eff.org/files/2016/07/18/eff_large_wordlist.txt (EFF, CC BY 3.0 US:
# https://www.eff.org/dice and https://creativecommons.org/licenses/by/3.0/us/). CI checks the .txt against that URL.
# usage: vendor/wordlist.sh
set -eu
cd "$(dirname "$0")"
{
  echo '// Generated from eff_large_wordlist.txt by wordlist.sh: the EFF Large Wordlist for passphrases (Electronic Frontier'
  echo '// Foundation, CC BY 3.0 US): https://www.eff.org/dice. 7,776 words, about 12.9 bits each.'
  echo 'export const EFF_LARGE_WORDLIST = `'
  cut -f2 eff_large_wordlist.txt
  echo '`;'
} > eff_large_wordlist.js
