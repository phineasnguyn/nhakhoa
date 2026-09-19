"""Run only disposable fixtures. Does not load .env or touch existing Docker stacks."""
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
SUFFIX = uuid.uuid4().hex[:10]
NAMES = []


def command(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def start(role, image, port, args):
    name = 'overlay-test-' + SUFFIX + '-' + role
    command('docker', 'run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::' + str(port), *args, image,
            *(['server', '/data'] if role == 'minio' else []))
    NAMES.append(name)
    mapping = json.loads(command('docker', 'inspect', name))[0]['NetworkSettings']['Ports'][str(port) + '/tcp']
    return mapping[0]['HostPort']


def wait_until(fn):
    deadline = time.time() + 60
    while time.time() < deadline:
        try:
            if fn():
                return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError('Disposable service did not become ready')


try:
    dbname = 'overlay_test_' + SUFFIX
    pg = start('postgres', 'postgres:15-alpine', 5432,
               ['-e', 'POSTGRES_PASSWORD=fixture-only', '-e', 'POSTGRES_DB=' + dbname])
    pgname = NAMES[-1]
    mini = start('minio', 'minio/minio:latest', 9000,
                 ['-e', 'MINIO_ROOT_USER=fixtureadmin', '-e', 'MINIO_ROOT_PASSWORD=fixture-only-password'])
    redis = start('redis', 'redis:7-alpine', 6379, [])
    processor = start('processor', 'nhakhoa-dev-image-processor:latest', 8001,
                      ['-v', str(ROOT / 'image-processing-service') + ':/app:ro'])
    wait_until(lambda: subprocess.call(['docker', 'exec', pgname, 'pg_isready', '-U', 'postgres'],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0)
    wait_until(lambda: urllib.request.urlopen('http://127.0.0.1:' + mini + '/minio/health/live', timeout=2).status == 200)
    wait_until(lambda: urllib.request.urlopen('http://127.0.0.1:' + processor + '/api/health', timeout=2).status == 200)
    # 001 provisions a deployment user/database and is not valid vanilla PostgreSQL SQL.
    # Fixtures use the already-created disposable database; apply the schema onward.
    for sql in sorted((ROOT / 'init-db').glob('*.sql')):
        if sql.name.startswith(('001_', '005_')):
            continue
        subprocess.run(['docker', 'exec', '-i', pgname, 'psql', '-U', 'postgres', '-d', dbname, '-v', 'ON_ERROR_STOP=1'],
                       input=sql.read_bytes(), check=True, stdout=subprocess.DEVNULL)
    migration = (ROOT / 'init-db/011_add_image_overlay_metadata.sql').read_bytes()
    subprocess.run(['docker', 'exec', '-i', pgname, 'psql', '-U', 'postgres', '-d', dbname, '-v', 'ON_ERROR_STOP=1'],
                   input=migration, check=True, stdout=subprocess.DEVNULL)
    env = {**os.environ, 'RUN_IMAGE_OVERLAY_INTEGRATION': 'true', 'DB_HOST': '127.0.0.1', 'DB_PORT': pg,
           'DB_NAME': dbname, 'DB_USER': 'postgres', 'DB_PASSWORD': 'fixture-only',
           'MINIO_HOST': '127.0.0.1', 'MINIO_PORT': mini, 'MINIO_ACCESS_KEY': 'fixtureadmin',
           'MINIO_SECRET_KEY': 'fixture-only-password', 'MINIO_USE_SSL': 'false', 'MINIO_BUCKET': 'overlay-test-' + SUFFIX,
           'REDIS_HOST': '127.0.0.1', 'REDIS_PORT': redis, 'IMAGE_PROCESSING_SERVICE_URL': 'http://127.0.0.1:' + processor}
    subprocess.run(['node', '--test', 'src/services/imageOverlay.integration.test.js'], cwd=ROOT / 'backend', env=env, check=True)
finally:
    for name in reversed(NAMES):
        subprocess.run(['docker', 'rm', '-f', '-v', name], stdout=subprocess.DEVNULL)
