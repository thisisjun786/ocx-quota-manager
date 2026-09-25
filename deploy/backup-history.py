#!/usr/bin/python3
"""Consistent online SQLite backup; rotate only receipts owned by this script."""
import argparse
from contextlib import closing
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile


def backup(source, directory, keep=7):
    source, directory = Path(source).resolve(), Path(directory).resolve()
    if not source.is_file() or source.parent == directory or keep < 1:
        raise ValueError('invalid backup configuration')
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (directory / '.backup.lock').open('a') as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        registry = directory / 'owned-backups.json'
        entries = json.loads(registry.read_text()) if registry.exists() else []
        if not isinstance(entries, list):
            raise ValueError('invalid backup registry')
        for entry in entries:
            name = entry.get('name', '')
            if Path(name).name != name or not name.startswith('history-') or not name.endswith('.sqlite'):
                raise ValueError('invalid owned backup name')
        fd, tmp = tempfile.mkstemp(prefix='.backup-', suffix='.partial', dir=directory)
        os.close(fd)
        temp = Path(tmp)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        dest = directory / ('history-' + stamp + '.sqlite')
        try:
            with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=5)) as src:
                with closing(sqlite3.connect(temp)) as target:
                    src.backup(target, pages=256, sleep=0.05)
                    if target.execute('pragma integrity_check').fetchone()[0] != 'ok':
                        raise RuntimeError('backup integrity failed')
            with temp.open('rb') as f:
                os.fsync(f.fileno())
                digest = hashlib.file_digest(f, 'sha256').hexdigest()
            os.replace(temp, dest)
            entry = {'name': dest.name, 'sha256': digest, 'bytes': dest.stat().st_size, 'createdAt': stamp}
            entries.append(entry)
            # Publish the new verified receipt before pruning older owned files.
            save_registry(registry, entries)
            remaining = entries[:]
            for expired in entries[:-keep]:
                path = directory / expired['name']
                if path.exists():
                    if path.is_symlink() or not path.is_file():
                        raise RuntimeError('owned backup path replaced')
                    with path.open('rb') as f:
                        if hashlib.file_digest(f, 'sha256').hexdigest() != expired['sha256']:
                            raise RuntimeError('owned backup changed; preserving it')
                    path.unlink()
                remaining.remove(expired)
            save_registry(registry, remaining)
            return entry
        finally:
            temp.unlink(missing_ok=True)


def save_registry(path, entries):
    fd, name = tempfile.mkstemp(prefix='.registry-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(entries, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        Path(name).unlink(missing_ok=True)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--source', required=True)
    p.add_argument('--directory', required=True)
    p.add_argument('--keep', type=int, default=7)
    args = p.parse_args()
    print(json.dumps(backup(args.source, args.directory, args.keep)))
