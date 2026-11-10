"""Build a verified compact database without changing the source database."""

import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import socket


def quoteIdentifier(value):
    return '"' + value.replace('"', '""') + '"'


def digestRows(connection, query, params=()):
    digest = hashlib.sha256()
    count = 0
    for row in connection.execute(query, params):
        digest.update(repr(row).encode('utf-8'))
        digest.update(b'\n')
        count += 1
    return {"rows": count, "sha256": digest.hexdigest()}


def buildCompactDatabase(sourcePath, candidatePath, keep=32):
    sourcePath = Path(sourcePath).resolve(strict=True)
    candidatePath = Path(candidatePath).resolve()
    if keep < 1 or candidatePath.exists() or candidatePath.parent != sourcePath.parent:
        raise ValueError('Use a new sibling database path and keep at least one snapshot')
    source = sqlite3.connect(sourcePath.as_uri() + '?mode=ro', uri=True)
    target = sqlite3.connect(candidatePath)
    report = {"source": str(sourcePath), "candidate": str(candidatePath), "keep": keep, "tables": {}}
    try:
        source.execute('BEGIN')
        target.execute('PRAGMA journal_mode=DELETE')
        target.execute('PRAGMA temp_store=MEMORY')
        schema = source.execute(
            "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid"
        ).fetchall()
        for kind, name, sql in schema:
            if kind == 'table':
                if 'VIRTUAL TABLE' in sql.upper():
                    raise ValueError('Virtual tables require a separate migration')
                target.execute(sql)
        target.execute('BEGIN')
        tables = [name for kind, name, sql in schema if kind == 'table']
        for name in tables:
            table = quoteIdentifier(name)
            query = f'SELECT * FROM {table}'
            params = ()
            if name == 'snapshots':
                snapshotIds = []
                for (instanceId,) in source.execute('SELECT DISTINCT instance_id FROM snapshots'):
                    snapshotIds.extend(row[0] for row in source.execute(
                        'SELECT id FROM snapshots WHERE instance_id = ? ORDER BY id DESC LIMIT ?',
                        (instanceId, keep)))
                query += ' WHERE id IN (' + ','.join('?' for _ in snapshotIds) + ')'
                params = tuple(snapshotIds)
            query += ' ORDER BY rowid'
            cursor = source.execute(query, params)
            placeholders = ','.join('?' for _ in cursor.description)
            while rows := cursor.fetchmany(128):
                target.executemany(f'INSERT INTO {table} VALUES ({placeholders})', rows)
            expected = digestRows(source, query, params)
            actual = digestRows(target, f'SELECT * FROM {table} ORDER BY rowid')
            if expected != actual:
                raise RuntimeError(f'Row verification failed: {name}')
            report['tables'][name] = actual
        # Preserve AUTOINCREMENT high-water marks, including discarded snapshots.
        target.execute('DELETE FROM sqlite_sequence')
        target.executemany('INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)',
                           source.execute('SELECT name,seq FROM sqlite_sequence'))
        for kind, name, sql in schema:
            if kind != 'table':
                target.execute(sql)
        for pragma in ('user_version', 'application_id'):
            value = source.execute(f'PRAGMA {pragma}').fetchone()[0]
            target.execute(f'PRAGMA {pragma}={value}')
        target.commit()
        if target.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise RuntimeError('Candidate integrity check failed')
        if target.execute('PRAGMA foreign_key_check').fetchall():
            raise RuntimeError('Candidate foreign-key check failed')
        report['sourceSnapshots'] = source.execute('SELECT count(*) FROM snapshots').fetchone()[0]
        report['integrity'] = 'ok'
    finally:
        target.close()
        source.close()
    report['sourceBytes'] = sourcePath.stat().st_size
    report['candidateBytes'] = candidatePath.stat().st_size
    return report


def activateCompactDatabase(sourcePath, candidatePath):
    sourcePath = Path(sourcePath).resolve(strict=True)
    candidatePath = Path(candidatePath).resolve(strict=True)
    reportPath = candidatePath.with_suffix('.verification.json')
    report = json.loads(reportPath.read_text(encoding='utf-8'))
    backupPath = sourcePath.with_name(sourcePath.name + '.before-storage-optimization-20261107.sqlite')
    if (report['source'] != str(sourcePath) or report['candidate'] != str(candidatePath)
            or report['integrity'] != 'ok' or backupPath.exists()
            or sourcePath.parent != candidatePath.parent):
        raise ValueError('Unexpected migration paths or verification report')
    for port in (8787, 8788):
        with socket.socket() as probe:
            probe.settimeout(1)
            if probe.connect_ex(('127.0.0.1', port)) == 0:
                raise RuntimeError('Stop the CL services before switching databases')
    if any(Path(str(candidatePath) + suffix).exists() for suffix in ('-wal', '-shm', '-journal')):
        raise RuntimeError('Candidate has sidecars; checkpoint and close all candidate connections first')
    source = sqlite3.connect(sourcePath, isolation_level=None)
    target = sqlite3.connect(candidatePath.as_uri() + '?mode=ro', uri=True)
    try:
        source.execute('BEGIN IMMEDIATE')
        schemaQuery = "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name"
        if source.execute(schemaQuery).fetchall() != target.execute(schemaQuery).fetchall():
            raise RuntimeError('Schema verification failed')
        if (target.execute('PRAGMA quick_check').fetchall() != [('ok',)]
                or target.execute('PRAGMA foreign_key_check').fetchall()):
            raise RuntimeError('Candidate integrity check failed')
        for name, expected in report['tables'].items():
            table = quoteIdentifier(name)
            query = f'SELECT * FROM {table}'
            params = ()
            if name == 'snapshots':
                ids = [row[0] for row in target.execute('SELECT id FROM snapshots ORDER BY id')]
                query += ' WHERE id IN (' + ','.join('?' for _ in ids) + ')'
                params = tuple(ids)
            if digestRows(source, query + ' ORDER BY rowid', params) != expected:
                raise RuntimeError(f'Source changed since verification: {name}')
            if digestRows(target, f'SELECT * FROM {table} ORDER BY rowid') != expected:
                raise RuntimeError(f'Candidate changed since verification: {name}')
        if source.execute('SELECT count(*) FROM snapshots').fetchone()[0] != report['sourceSnapshots']:
            raise RuntimeError('Source snapshot count changed')
        if source.execute('SELECT name,seq FROM sqlite_sequence ORDER BY name').fetchall() != target.execute(
                'SELECT name,seq FROM sqlite_sequence ORDER BY name').fetchall():
            raise RuntimeError('Sequence verification failed')
        source.execute('ROLLBACK')
        checkpoint = source.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
        if checkpoint[0] != 0:
            raise RuntimeError('Source WAL checkpoint is busy')
    finally:
        target.close()
        source.close()
    # A busy WAL or SHM means another connection may still own the database.
    if any(Path(str(sourcePath) + suffix).exists() for suffix in ('-wal', '-shm')):
        raise RuntimeError('Source sidecars still exist; do not switch with active connections')
    sourcePath.rename(backupPath)
    try:
        candidatePath.rename(sourcePath)
    except BaseException:
        backupPath.rename(sourcePath)
        raise
    return {"active": str(sourcePath), "backup": str(backupPath), "activeBytes": sourcePath.stat().st_size}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source')
    parser.add_argument('candidate')
    parser.add_argument('--keep', type=int, default=32)
    parser.add_argument('--activate', action='store_true')
    args = parser.parse_args()
    if args.activate:
        result = activateCompactDatabase(args.source, args.candidate)
    else:
        result = buildCompactDatabase(args.source, args.candidate, args.keep)
        reportPath = Path(args.candidate).with_suffix('.verification.json')
        reportPath.write_text(json.dumps(result, indent=4), encoding='utf-8')
    print(json.dumps(result, indent=4), flush=True)
