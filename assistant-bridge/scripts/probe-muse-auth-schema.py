"""Read bounded schema-string excerpts from the official Muse executable only.

This static probe never executes Muse, opens an account/profile, or reads an
auth file. Pass the pinned installed binary path. Output contains a binary
fingerprint and fixed-size printable excerpts around known schema labels.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import mmap
from pathlib import Path

MARKERS = [b"credential_backend", b"MetaOAuth", b"ProviderCredential", b"refresh_token",
           b"access_token", b"expires_at", b"api_base_url", b"mechanism"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    if binary.name.lower() not in {"muse", "muse.exe"} or not binary.is_file():
        parser.error("Pass only the installed official muse or muse.exe executable.")
    with binary.open("rb") as handle, mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as data:
        report = {"binary": binary.name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(), "markers": []}
        for marker in MARKERS:
            cursor, count, snippets = 0, 0, []
            while True:
                position = data.find(marker, cursor)
                if position < 0:
                    break
                count += 1
                if len(snippets) < 5:
                    segment = data[max(0, position - 180): min(len(data), position + len(marker) + 260)]
                    printable = "".join(chr(byte) if 32 <= byte <= 126 else " " for byte in segment)
                    snippets.append({"offset": position, "text": " ".join(printable.split())})
                cursor = position + len(marker)
            report["markers"].append({"name": marker.decode("ascii"), "count": count, "snippets": snippets})
    print(json.dumps(report, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
