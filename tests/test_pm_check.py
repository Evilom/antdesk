import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/pm-check.py'


class CheckRecorder(unittest.TestCase):
    def test_exit_status_is_durable_and_arguments_are_not_recorded(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()
            subprocess.run(['git','init','-q',str(root)],check=True)
            for code in [0,7]:
                run=subprocess.run([sys.executable,str(SCRIPT),'--kind','test','--label','单元测试','--',sys.executable,'-c',f'import sys; sys.exit({code})','SENSITIVE_ARGUMENT'],cwd=root)
                self.assertEqual(run.returncode,code)
            content=(root/'.antdesk/checks.jsonl').read_text()
            self.assertNotIn('SENSITIVE_ARGUMENT',content)
            records=[json.loads(line) for line in content.splitlines()]
            self.assertEqual([r['status'] for r in records],['running','passed','running','failed'])
            self.assertEqual(records[-1]['exitCode'],7)
            self.assertEqual(records[-1]['project'],str(root))
            self.assertFalse(records[-1]['clean'])


if __name__ == '__main__':
    unittest.main()
