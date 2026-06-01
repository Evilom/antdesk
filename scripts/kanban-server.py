#!/usr/bin/env python3
"""
kanban-server.py — Lightweight HTTP server that serves kanban data for AntDesk

Usage:
  python3 kanban-server.py [--port 8765] [--db ~/.antdesk/kanban.json]

AntDesk connects to http://YOUR_IP:8765/kanban.json

The kanban.json file is updated by kanban-sync.sh (run via Hermes cron).
"""

import http.server
import json
import os
import sys
import argparse
from pathlib import Path
from datetime import datetime

DEFAULT_PORT = 8765
DEFAULT_DB = os.path.expanduser("~/.antdesk/kanban.json")

class KanbanHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/kanban.json" or self.path == "/":
            self.serve_kanban()
        elif self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "time": datetime.utcnow().isoformat()}).encode())
        else:
            self.send_error(404)

    def serve_kanban(self):
        db_path = self.server.kanban_db
        try:
            if os.path.exists(db_path):
                with open(db_path, "r") as f:
                    data = f.read()
            else:
                data = json.dumps({
                    "actions": [],
                    "completedToday": [],
                    "exportedAt": "",
                    "stats": {"pending": 0, "active": 0, "blocked": 0, "completedToday": 0}
                })

            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data.encode("utf-8"))
        except Exception as e:
            self.send_error(500, str(e))

    def log_message(self, format, *args):
        # Quieter logging
        pass

class KanbanServer(http.server.HTTPServer):
    def __init__(self, port, kanban_db):
        self.kanban_db = kanban_db
        super().__init__(("", port), KanbanHandler)

def main():
    parser = argparse.ArgumentParser(description="AntDesk Kanban Server")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--db", default=DEFAULT_DB)
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.db), exist_ok=True)

    # Create empty kanban file if it doesn't exist
    if not os.path.exists(args.db):
        with open(args.db, "w") as f:
            json.dump({
                "actions": [],
                "completedToday": [],
                "exportedAt": datetime.utcnow().isoformat(),
                "stats": {"pending": 0, "active": 0, "blocked": 0, "completedToday": 0}
            }, f)

    server = KanbanServer(args.port, args.db)
    print(f"🐾 AntDesk Kanban Server")
    print(f"   Port: {args.port}")
    print(f"   DB:   {args.db}")
    print(f"   URL:  http://localhost:{args.port}/kanban.json")
    print(f"   Press Ctrl+C to stop")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        server.server_close()

if __name__ == "__main__":
    main()
