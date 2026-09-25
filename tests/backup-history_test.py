import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest
import json

spec = importlib.util.spec_from_file_location('backup_history', Path(__file__).parents[1] / 'deploy/backup-history.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class BackupTests(unittest.TestCase):
    def test_wal_backup_rotation_and_unowned_preservation(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);source=root/'live.sqlite';directory=root/'backups'
            with sqlite3.connect(source) as c:
                c.execute('pragma journal_mode=wal');c.execute('create table example(value)');c.execute('insert into example values (42)');c.commit()
                first=module.backup(source,directory,1)
                unknown=directory/'history-unowned.sqlite';unknown.write_text('preserve')
                second=module.backup(source,directory,1)
                self.assertFalse((directory/first['name']).exists())
                self.assertEqual(unknown.read_text(),'preserve')
                with sqlite3.connect(directory/second['name']) as restored:
                    self.assertEqual(restored.execute('select value from example').fetchone(),(42,))
                self.assertEqual(len(json.loads((directory/'owned-backups.json').read_text())),1)
    def test_changed_backup_is_not_deleted(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);source=root/'live.sqlite';directory=root/'backups'
            with sqlite3.connect(source) as c:c.execute('create table example(value)')
            first=module.backup(source,directory,1);old=directory/first['name'];old.write_text('changed')
            with self.assertRaises(RuntimeError):module.backup(source,directory,1)
            self.assertEqual(old.read_text(),'changed')
            self.assertEqual(len(list(directory.glob('history-*.sqlite'))),2)
    def test_invalid_source_preserves_existing_backup(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);source=root/'live.sqlite';source.write_text('bad db')
            directory=root/'backups';directory.mkdir();old=directory/'keep.sqlite';old.write_text('keep')
            with self.assertRaises(sqlite3.DatabaseError):module.backup(source,directory)
            self.assertEqual(old.read_text(),'keep')
            self.assertFalse(list(directory.glob('*.partial')))

if __name__=='__main__':unittest.main()
