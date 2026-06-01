#!/usr/bin/env bash
# kanban-push.sh — Called by Hermes agent to push kanban state
#
# Usage: echo '{"actions":[],...}' | ./kanban-push.sh
#    or: ./kanban-push.sh /path/to/kanban.json
#
# Writes to ~/.antdesk/kanban.json which is served by kanban-server.py

set -euo pipefail

OUTPUT_DIR="${KANBAN_DIR:-$HOME/.antdesk}"
OUTPUT_FILE="$OUTPUT_DIR/kanban.json"

mkdir -p "$OUTPUT_DIR"

if [ $# -ge 1 ] && [ -f "$1" ]; then
    # Copy from file
    cp "$1" "$OUTPUT_FILE"
else
    # Read from stdin
    cat > "$OUTPUT_FILE"
fi

echo "[$(date '+%H:%M:%S')] Kanban updated: $(python3 -c "import json; d=json.load(open('$OUTPUT_FILE')); print(f'{d[\"stats\"][\"active\"]} active, {d[\"stats\"][\"blocked\"]} blocked, {d[\"stats\"][\"pending\"]} pending')" 2>/dev/null || echo "written")"
