#!/bin/bash
# Dormeto demo (terraform/gcp-dev): the app on port 80 and a stand-in for Dormeto's waker on 8080, each a page with
# the instance's name and boot time. Compute Engine runs this startup script at every boot, not after a resume: a
# resumed VM keeps the boot time it showed, a started one shows a new one (gcp/tools/measure.mjs tells them apart so).
set -euo pipefail

name=$(curl -sS --retry 5 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/name || hostname)
boot=$(date -u -d "@$(($(date +%s) - $(cut -d. -f1 /proc/uptime)))" +%Y-%m-%dT%H:%M:%SZ)

page() { # $1: what the page is, $2: its directory
  mkdir -p "$2"
  cat >"$2/index.html" <<HTML
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Dormeto demo: $1</title></head>
<body><h1>Dormeto demo: $1</h1><p>Instance <code id="instance">$name</code> booted at <time id="boot">$boot</time>.</p></body></html>
HTML
}

serve() { # $1: the unit, $2: the port, $3: the directory
  systemctl stop "$1" 2>/dev/null || true
  systemctl reset-failed "$1" 2>/dev/null || true
  systemd-run --unit "$1" --property Restart=always /usr/bin/python3 -m http.server "$2" --directory "$3"
}

page app /srv/dormeto-demo/app
page stand-in /srv/dormeto-demo/standin
serve dormeto-demo-app 80 /srv/dormeto-demo/app
serve dormeto-demo-standin 8080 /srv/dormeto-demo/standin
