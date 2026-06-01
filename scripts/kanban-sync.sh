#!/usr/bin/env bash
# kanban-sync.sh — Sync agentmemory data to kanban JSON for AntDesk
#
# This reads from agentmemory's local.db (JSON format) and exports
# relevant memories/decisions as kanban-style items.
#
# Run via Hermes cron or manually.

set -euo pipefail

DB_PATH="${AGENTMEMORY_DB:-$HOME/.agentmemory/local.db}"
OUTPUT_DIR="${KANBAN_DIR:-$HOME/.antdesk}"
OUTPUT_FILE="$OUTPUT_DIR/kanban.json"

mkdir -p "$OUTPUT_DIR"

python3 << 'PYTHON'
import json, os
from datetime import datetime, timedelta

db_path = os.path.expanduser("~/.agentmemory/local.db")
output_path = os.path.expanduser("~/.antdesk/kanban.json")

try:
    with open(db_path) as f:
        data = json.load(f)
except:
    data = {}

memories = data.get("mem:memories", {})
now = datetime.utcnow()
today = now.strftime("%Y-%m-%d")

# Convert memories to kanban-style actions
actions = []
completed_today = []

for mid, mem in memories.items():
    title = mem.get("title", "")
    content = mem.get("content", "")
    mem_type = mem.get("type", "fact")
    updated = mem.get("updatedAt", "")
    created = mem.get("createdAt", "")
    strength = mem.get("strength", 5)
    
    # Skip very weak memories
    if strength < 3:
        continue
    
    # Determine status based on recency and type
    if updated and updated[:10] == today:
        status = "active"
    elif mem_type in ("workflow", "decision"):
        status = "pending"
    else:
        status = "pending"
    
    # Priority based on strength and type
    priority = min(10, max(1, strength))
    if mem_type == "workflow":
        priority = min(10, priority + 2)
    
    action = {
        "id": mid,
        "title": title[:80] if title else "(untitled)",
        "description": content[:200] if content else "",
        "status": status,
        "priority": priority,
        "tags": mem.get("concepts", []),
        "project": "",
        "createdAt": created,
        "updatedAt": updated,
    }
    
    actions.append(action)

# Sort by priority (high first)
actions.sort(key=lambda a: a["priority"], reverse=True)

# Build output
output = {
    "actions": [a for a in actions if a["status"] != "done"],
    "completedToday": completed_today,
    "exportedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
    "stats": {
        "pending": sum(1 for a in actions if a["status"] == "pending"),
        "active": sum(1 for a in actions if a["status"] == "active"),
        "blocked": sum(1 for a in actions if a["status"] == "blocked"),
        "completedToday": len(completed_today),
    }
}

with open(output_path, "w") as f:
    json.dump(output, f, ensure_ascii=False, indent=2)

print(f"Synced: {output['stats']['active']} active, {output['stats']['pending']} pending, {output['stats']['blocked']} blocked")
PYTHON
