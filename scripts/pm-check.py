#!/usr/bin/env python3
"""Run an explicitly requested build/test and append its observed exit status for AntDesk."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
import uuid


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], stderr=subprocess.DEVNULL).decode().strip()


def state(root):
    try:
        return git(root, "rev-parse", "HEAD"), not git(root, "status", "--porcelain", "--", ".", ":(exclude).antdesk")
    except subprocess.CalledProcessError:
        return "", False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kind", choices=["build", "test"], required=True)
    parser.add_argument("--label", default="")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("需要在 -- 后提供构建或测试命令")
    root = Path(git(Path.cwd(), "rev-parse", "--show-toplevel")).resolve()
    directory = root / ".antdesk"
    if directory.is_symlink():
        parser.error(".antdesk 不能是符号链接")
    directory.mkdir(mode=0o700, exist_ok=True)
    target = directory / "checks.jsonl"
    if target.is_symlink():
        parser.error("checks.jsonl 不能是符号链接")
    head, clean = state(root)
    record = dict(schema=1, id=str(uuid.uuid4()), project=str(root), kind=args.kind,
                  label=(args.label or Path(command[0]).name)[:120], head=head,
                  clean=clean, startedAt=int(time.time()), completedAt=None,
                  status="running", exitCode=None)
    # Never store command arguments or command output: they may contain credentials.
    flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(target, flags, 0o600), "a", encoding="utf-8") as f:
        def append():
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
            f.flush()
            os.fsync(f.fileno())
        append()
        try:
            code = subprocess.call(command)
        except KeyboardInterrupt:
            code = 130
        except OSError as exc:
            print(f"无法启动命令：{exc}")
            code = 127
        after, after_clean = state(root)
        record.update(status="passed" if code == 0 else "cancelled" if code == 130 else "failed",
                      exitCode=code, completedAt=int(time.time()),
                      clean=clean and after_clean and head == after)
        append()
    return code if code >= 0 else 128 - code


if __name__ == "__main__":
    raise SystemExit(main())
