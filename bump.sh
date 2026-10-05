#!/bin/sh
# Raises the release number on the page and on every module it loads, so a
# phone holding the old files in its cache (GitHub Pages: ten minutes) fetches
# the new ones as soon as the app is reopened. Run before each commit.
cd "$(dirname "$0")" || exit 1
now=$(grep -o 'app\.js?v=[0-9]*' index.html | head -1 | sed 's/.*=//')
next=$((now + 1))
for f in index.html *.js; do
  sed -i.bak -E "s/(\.js)\?v=[0-9]+/\1?v=$next/g" "$f" && rm -f "$f.bak"
done
echo "v=$now -> v=$next"
