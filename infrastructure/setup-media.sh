#!/bin/sh
set -eu
python3 - <<'PY'
import fcntl, os, re, secrets, stat, tempfile
from pathlib import Path

path = Path('.env').resolve()
directory = os.open(path.parent,os.O_RDONLY | os.O_DIRECTORY)
try:
    fcntl.flock(directory,fcntl.LOCK_EX)
    previous = ''
    if path.exists():
        mode = path.stat().st_mode
        if not stat.S_ISREG(mode) or mode & 0o077:
            raise SystemExit('Use a private .env file (0600). A symlink to a private filesystem is supported.')
        previous = path.read_text()
    settings = previous
    for name in ('DB_PASSWORD','API_DB_PASSWORD','WORKER_DB_PASSWORD','MEDIA_KEK'):
        pattern = re.compile('^' + name + '=(.*)$',re.M)
        matches = pattern.findall(settings)
        if len(matches) > 1:
            raise SystemExit('Duplicate ' + name)
        if matches and matches[0]:
            if name in ('WORKER_DB_PASSWORD','MEDIA_KEK') and not re.fullmatch('[a-f0-9]{64}', matches[0]):
                raise SystemExit('Expected 64 lowercase hex characters in ' + name)
            continue
        value = name + '=' + secrets.token_hex(32)
        settings = pattern.sub(value,settings) if matches else settings.rstrip('\n')+'\n'+value+'\n'
    if settings != previous:
        with tempfile.NamedTemporaryFile(mode='w',dir=path.parent,delete=False) as tmp:
            try:
                if os.fstat(tmp.fileno()).st_mode & 0o077:
                    raise SystemExit('Choose a filesystem that supports private file permissions.')
                tmp.write(settings.lstrip('\n'))
                tmp.flush()
                os.fsync(tmp.fileno())
                os.replace(tmp.name,path)
                os.fsync(directory)
            finally:
                Path(tmp.name).unlink(missing_ok=True)
finally:
    os.close(directory)
print('Environment ready.')
PY
