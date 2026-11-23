import importlib.util
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('compactStorage', Path(__file__).with_name('compact-storage.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CompactStorageTests(unittest.TestCase):
    def testRetainsLatestPerInstanceAndPreservesAllOtherRows(self):
        with tempfile.TemporaryDirectory() as tempDir:
            sourcePath = Path(tempDir) / 'source.db'
            candidatePath = Path(tempDir) / 'candidate.db'
            with closing(sqlite3.connect(sourcePath)) as db:
                db.executescript('''
                    CREATE TABLE memories(id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT);
                    CREATE TABLE snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT, instance_id TEXT, payload TEXT);
                    CREATE INDEX snapshot_instance ON snapshots(instance_id,id);
                    INSERT INTO memories(content) VALUES ('preserve this memory');
                ''')
                for i in range(10):
                    for instanceId in ('a', 'b'):
                        db.execute('INSERT INTO snapshots(instance_id,payload) VALUES (?,?)', (instanceId, str(i)))
                db.commit()
            report = module.buildCompactDatabase(sourcePath, candidatePath, keep=2)
            self.assertEqual(report['sourceSnapshots'], 20)
            with closing(sqlite3.connect(candidatePath)) as db:
                self.assertEqual(db.execute('SELECT instance_id,payload FROM snapshots ORDER BY id').fetchall(),
                                 [('a', '8'), ('b', '8'), ('a', '9'), ('b', '9')])
                self.assertEqual(db.execute('SELECT content FROM memories').fetchall(), [('preserve this memory',)])
                self.assertEqual(db.execute("SELECT seq FROM sqlite_sequence WHERE name='snapshots'").fetchone(), (20,))
            with closing(sqlite3.connect(sourcePath)) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM snapshots').fetchone(), (20,))
            with self.assertRaises(ValueError):
                module.buildCompactDatabase(sourcePath, candidatePath)
            candidatePath.with_suffix('.verification.json').write_text(json.dumps(report), encoding='utf-8')
            result = module.activateCompactDatabase(sourcePath, candidatePath)
            self.assertFalse(candidatePath.exists())
            with closing(sqlite3.connect(sourcePath)) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM snapshots').fetchone(), (4,))
            with closing(sqlite3.connect(result['backup'])) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM snapshots').fetchone(), (20,))


if __name__ == '__main__':
    unittest.main()
