#!/usr/bin/env bash
# Fetch the latin (and latin-ext) woff2 subsets from a Google Fonts css2 response.
set -euo pipefail
cd "$(dirname "$0")"
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

# emit "subset url" pairs for each @font-face block
parse() {
  awk '
    /\/\* [a-z-]+ \*\// { sub=$2; gsub(/[\/\* ]/,"",sub) }
    /font-weight:/ { w=$3; gsub(/;/,"",w) }
    /family:/ { fam=$0; sub(/.*: /,"",fam); gsub(/[;\x27]/,"",fam) }
    /url\(https/ { url=$0; sub(/.*url\(/,"",url); sub(/\).*/,"",url); print sub" "w" "fam" "url }
  ' "$1"
}

mkdir -p dl
# Source Serif 4: variable ranges come as one URL per subset for the full weight axis
parse ss4.css > ss4.txt
parse plex.css > plex.txt
while read -r sub w fam url; do
  case "$sub" in latin|latin-ext) ;; *) continue;; esac
  safe=$(echo "$fam" | tr ' ' '-')
  out="dl/${safe}-w${w}-${sub}.woff2"
  [ -f "$out" ] || curl -s --max-time 30 -o "$out" "$url"
  echo "$out $(wc -c <"$out")"
done < ss4.txt
while read -r sub w fam url; do
  case "$sub" in latin|latin-ext) ;; *) continue;; esac
  safe=$(echo "$fam" | tr ' ' '-')
  out="dl/${safe}-w${w}-${sub}.woff2"
  [ -f "$out" ] || curl -s --max-time 30 -o "$out" "$url"
  echo "$out $(wc -c <"$out")"
done < plex.txt
