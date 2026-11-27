#!/usr/bin/env python3
"""Download a pinned public upstream archive. Never read a wallet or local credentials."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / 'upstream-lock.json').read_text())
MAX_BYTES = 150_000_000


def extract(archive, target):
    prefix = 'privacy-ring-examples-' + LOCK['commit']
    total, count = 0, 0
    with tarfile.open(archive, 'r:gz') as tf:
        for member in tf:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != prefix:
                raise ValueError('Unexpected archive path')
            if not member.isdir() and not member.isfile():
                raise ValueError('Links and special files are not allowed')
            count += 1
            total += member.size
            if count > 20000 or total > MAX_BYTES:
                raise ValueError('Archive too large')
            p = target.joinpath(*path.parts[1:])
            if member.isdir():
                p.mkdir(parents=True, exist_ok=True)
            else:
                p.parent.mkdir(parents=True, exist_ok=True)
                with tf.extractfile(member) as src, p.open('xb') as dst:
                    while chunk := src.read(1024 * 1024):
                        dst.write(chunk)
                p.chmod(0o700 if member.mode & 0o111 else 0o600)
    for rel, expected in LOCK['blobs'].items():
        content = (target / rel).read_bytes()
        actual = hashlib.sha1(f'blob {len(content)}\0'.encode() + content).hexdigest()
        if actual != expected:
            raise ValueError(f'Pinned Git blob mismatch: {rel}')
    print(f"Verified {len(LOCK['blobs'])} selected upstream Git blobs at {LOCK['commit']}")


def main():
    target = Path(sys.argv[1]).resolve()
    target.mkdir(mode=0o700, exist_ok=False)
    archive = target.parent / 'upstream.tar.gz'
    subprocess.run(['curl', '-q', '--proto', '=https', '--tlsv1.2', '-fL', '--retry', '2', '--max-time', '180', '--max-filesize', str(MAX_BYTES), '-o', str(archive), LOCK['archive']], check=True)
    if archive.stat().st_size > MAX_BYTES:
        raise ValueError('Download too large')
    extract(archive, target)
    archive.unlink()

if __name__ == '__main__':
    main()
