#!/usr/bin/env bash
# Sample the Tauri process tree while the chat panel misbehaves.
#
# Why this exists: the panel sometimes blanks with no Rust panic, no JS error,
# no segfault, and no OOM kill. The remaining suspects are (a) the web process
# spinning until the WebKit watchdog kills it, or (b) something outside the app.
# CPU and RSS over time separate those: a renderer at ~100% CPU that then
# vanishes was killed for being unresponsive; a renderer at 0% CPU that vanishes
# was killed by something else.
#
# Usage:
#   scripts/watch-renderer.sh            # sample every 2s until Ctrl-C
#   scripts/watch-renderer.sh 0.5        # tighter interval
#
# Leave it running, reproduce the blanking, then read the last lines.

set -uo pipefail

interval="${1:-2}"

echo "sampling every ${interval}s — reproduce the blanking, then Ctrl-C"
printf '%-8s %-6s %-6s %-9s %s\n' TIME CPU% RSS_KB ELAPSED COMMAND

while true; do
  # Match the app and any WebKit helper it spawned. Exclude this watcher and its
  # own shell, whose command line contains the search pattern.
  ps -eo pid,pcpu,rss,etimes,args --sort=-pcpu \
    | grep -iE 'payoff-explorer|WebKitWebProcess|WebKitNetworkProcess|fina-mcp' \
    | grep -v grep \
    | grep -v watch-renderer.sh \
    | awk -v now="$(date +%s)" '
        {
          cpu = $2; rss = $3; elapsed = $4;
          cmd = $5;
          for (i = 6; i <= NF; i++) cmd = cmd " " $i;
          if (length(cmd) > 60) cmd = substr(cmd, 1, 60) "...";
          printf "%-8s %-6s %-6s %-9s %s\n", strftime("%H:%M:%S"), cpu, rss, elapsed "s", cmd;
        }'
  sleep "$interval"
done