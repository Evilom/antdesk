import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / "runtime" / "python" / "deepseek_worker.py"
SPEC = importlib.util.spec_from_file_location("antdesk_deepseek_worker", MODULE_PATH)
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class PublicErrorsTest(unittest.TestCase):
    def test_documented_terminal_failure_retains_category_but_not_message(self):
        reason = {"reason": {"kind": "error", "failure": {
            "code": "ACCOUNT_TOKEN_INVALID", "message": "credential-must-not-escape",
        }}}
        self.assertEqual(worker.public_error_code(reason), "ACCOUNT_TOKEN_INVALID")

    def test_wrapped_exception_does_not_parse_or_return_arbitrary_error_text(self):
        failure = RuntimeError("AUTHENTICATION secret-token from stderr")
        self.assertIsNone(worker.public_error_code(failure))
        failure.data = {"error": {"code": "RATE_LIMIT", "message": "another-secret"}}
        self.assertEqual(worker.public_error_code(failure), "RATE_LIMIT")

    def test_cycle_and_unknown_failure_are_bounded(self):
        cyclic = {}
        cyclic["cause"] = cyclic
        self.assertIsNone(worker.public_error_code(cyclic))
        self.assertIsNone(worker.public_error_code({"code": "arbitrary-provider-secret"}))


if __name__ == "__main__":
    unittest.main()
