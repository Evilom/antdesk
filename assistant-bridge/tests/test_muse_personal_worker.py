"""Offline protocol-boundary tests. No browser, credentials, or network access."""
import importlib.util
import io
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "runtime" / "python" / "muse_personal_worker.py"
spec = importlib.util.spec_from_file_location("muse_personal_worker", SCRIPT)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class FakeGateway:
    def __init__(self, cookies, vm_id=None, access_token=None, hatch_token=None):
        self.cookies = cookies
        self.vm_id = vm_id or "vm-original"
        self.credentials = {"access_token": access_token, "hatch_token": hatch_token}
        self.calls = []
        self.closed = False

    def call_json(self, method, body=None):
        self.calls.append((method, body))
        if method == "identity":
            return {"name": "原 Muse", "private_credentials": "never-return"}
        if method == "session.start":
            return {"session_id": "side-one"}
        if method == "session.rename":
            return {"updated": True}
        if method == "chat.history":
            return {"chat_events": [{"seq": 5, "event_name": "message.assistant", "payload": {
                "display_text": "回复", "status": "completed", "message_id": "m5", "private": "never-return"}}]}
        if method == "sessions.list":
            return {"sessions": [{"session_id": "side-one", "title": "原会话", "archived": False}]}
        raise RuntimeError("Unexpected method")

    def _open(self, method, body=None):
        self.calls.append((method, body))
        if getattr(self, "fail_send", False):
            raise RuntimeError("credential-bearing error must not escape")
        return 7

    def close(self):
        self.closed = True


class MuseWorkerTests(unittest.TestCase):
    def setUp(self):
        worker.GATEWAY = None
        worker.ACCOUNT = None
        worker.STOPPED = False
        worker.SENT_RUNS.clear()

    def initialize(self):
        fake_module = types.SimpleNamespace(Gateway=FakeGateway,
            fetch_session_info=lambda cookies: {"vm_id": "vm-original"},
            fetch_access_token=lambda cookies: "only-in-worker-access-token",
            fetch_hatch_token=lambda cookies, token, vm_id: "only-in-worker-hatch-token")
        with patch.dict(sys.modules, {"muse_cli.gateway": fake_module}), patch.object(worker.importlib.metadata, "version", return_value="0.3.10"):
            return worker.dispatch("initialize", {"cookies": "hatch_sess=dedicated"})

    def test_uses_explicit_cookies_and_returns_only_allowlisted_identity(self):
        result = self.initialize()
        self.assertEqual(worker.GATEWAY.cookies, "hatch_sess=dedicated")
        self.assertEqual(result["account"], {"id": "vm-original", "name": "原 Muse"})
        self.assertNotIn("dedicated", json.dumps(result))
        self.assertNotIn("never-return", json.dumps(result))

    def test_session_creation_matches_the_sdk_and_history_is_read_only(self):
        self.initialize()
        self.assertEqual(worker.dispatch("session/create", {}), {"sessionId": "side-one"})
        method, body = worker.GATEWAY.calls[-1]
        self.assertEqual(method, "session.start")
        self.assertEqual(body, {"method": "/api/session/start", "params": {"origin": "fresh", "lifecycle": "persistent"}})
        history = worker.dispatch("history/read", {"sessionId": "side-one", "limit": 100})
        self.assertEqual(history["events"][0]["status"], "completed")
        self.assertNotIn("never-return", json.dumps(history))
        self.assertNotIn("chat.stream", [method for method, _ in worker.GATEWAY.calls])

    def test_uncertain_send_is_reserved_before_network_and_never_replayed(self):
        self.initialize()
        worker.GATEWAY.fail_send = True
        params = {"runId": "run-one", "sessionId": "side-one", "nodeId": "node-one", "text": "任务"}
        with self.assertRaises(RuntimeError):
            worker.dispatch("chat/send", params)
        with self.assertRaises(RuntimeError):
            worker.dispatch("chat/send", params)
        self.assertEqual(sum(method == "chat.stream" for method, _ in worker.GATEWAY.calls), 1)

    def test_send_uses_proven_fields_and_never_treats_local_stream_number_as_receipt(self):
        self.initialize()
        result = worker.dispatch("chat/send", {"runId": "run-one", "sessionId": "side-one", "nodeId": "node-one", "text": "任务"})
        self.assertEqual(result, {"submitted": True, "accepted": False})
        method, body = worker.GATEWAY.calls[-1]
        self.assertEqual(method, "chat.stream")
        self.assertEqual(body["session_id"], "side-one")
        self.assertEqual(body["items"], [{"type": "text", "text": "任务"}])
        self.assertNotIn("idempotencyKey", body)

    def test_shutdown_and_unknown_cancel_do_not_claim_remote_stop(self):
        self.initialize()
        self.assertFalse(worker.dispatch("chat/cancel", {"sessionId": "side-one"})["remoteStopped"])
        self.assertFalse(worker.dispatch("shutdown", {})["remoteStopped"])
        self.assertTrue(worker.GATEWAY.closed)

    def test_errors_return_only_category_without_sdk_exception_text(self):
        output = io.StringIO()
        with patch.object(worker, "dispatch", side_effect=RuntimeError("hatch_sess=secret-token")), patch.object(sys, "stdout", output):
            worker.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize"})
        result = json.loads(output.getvalue())
        self.assertEqual(result["error"]["data"]["kind"], "RuntimeError")
        self.assertNotIn("secret-token", output.getvalue())

    def test_sdk_auth_error_http_status_is_classified_without_returning_its_body(self):
        AuthError = type("AuthError", (RuntimeError,), {})
        cases = [(401, "auth_required", False), (403, "access_denied", False),
                 (429, "rate_limited", True), (503, "service_unavailable", True)]
        for status, code, retryable in cases:
            with self.subTest(status=status):
                failure = AuthError(f"auth/check -> {status} hatch_sess=private-secret")
                public = worker.public_failure(failure)
                self.assertEqual(public, {"kind": "AuthError", "stage": "authorization", "code": code,
                                          "httpStatus": status, "retryable": retryable})
                self.assertNotIn("private-secret", json.dumps(public))

    def test_vm_starting_is_retryable_and_auth_non_json_is_not_an_expired_cookie(self):
        GatewayError = type("GatewayError", (RuntimeError,), {})
        failure = GatewayError("private payload")
        failure.status = -1
        failure.payload = "VM unavailable ({'status': 'unavailable', 'private': 'secret'}); retry shortly"
        self.assertEqual(worker.public_failure(failure, "session"), {
            "kind": "GatewayError", "stage": "session", "code": "vm_unavailable", "retryable": True})
        AuthError = type("AuthError", (RuntimeError,), {})
        self.assertEqual(worker.public_failure(AuthError("api/session returned non-JSON ('private secret')")), {
            "kind": "AuthError", "stage": "session", "code": "invalid_response", "httpStatus": 200, "retryable": True})

    def test_initialize_records_the_failed_protocol_stage_and_never_returns_token_values(self):
        fake_module = types.SimpleNamespace(
            fetch_session_info=lambda cookies: {"vm_id": "vm-original"},
            fetch_access_token=lambda cookies: "private-access-token",
            fetch_hatch_token=lambda *args: (_ for _ in ()).throw(TimeoutError("private-access-token")))
        output = io.StringIO()
        with patch.dict(sys.modules, {"muse_cli.gateway": fake_module}), patch.object(worker.importlib.metadata, "version", return_value="0.3.10"), patch.object(sys, "stdout", output):
            worker.handle({"id": 1, "method": "initialize", "params": {"cookies": "hatch_sess=private-cookie"}})
        result = json.loads(output.getvalue())
        self.assertEqual(result["error"]["data"], {"kind": "TimeoutError", "stage": "gateway_token", "code": "network_timeout", "retryable": True})
        self.assertNotIn("private-", output.getvalue())

    def test_suspended_vm_is_woken_before_the_gateway_connects(self):
        states = iter(["SUSPENDED", "SUSPENDED", "RUNNING"])
        wakes = []
        def session(_cookies):
            return {"vm_id": "vm-original", "vm_state": next(states)}
        def wake(_sdk, _cookies, _access_token, vm_id):
            wakes.append(vm_id)
            return 200
        fake_module = types.SimpleNamespace(Gateway=FakeGateway, fetch_session_info=session,
            fetch_access_token=lambda cookies: "access", fetch_hatch_token=lambda *args: "hatch",
            _hatch_headers=lambda *args: {"private": "header"})
        with patch.dict(sys.modules, {"muse_cli.gateway": fake_module}), patch.object(worker.importlib.metadata, "version", return_value="0.3.10"), patch.object(worker, "post_wake", wake), patch.object(worker.time, "sleep") as sleep:
            result = worker.dispatch("initialize", {"cookies": "hatch_sess=dedicated"})
        self.assertEqual(wakes, ["vm-original"])
        self.assertGreaterEqual(sleep.call_count, 1)
        self.assertEqual(result["account"]["id"], "vm-original")
        self.assertNotIn("dedicated", json.dumps(result))

    def test_gateway_502_is_retried_then_connected_without_leaking_the_socket_url(self):
        calls = {"n": 0}
        class FlakyGateway(FakeGateway):
            def __init__(self, *args, **kwargs):
                calls["n"] += 1
                if calls["n"] == 1:
                    raise OSError("wss://hatch.example/noise?auth_token=secret Refused WebSocket upgrade: 502")
                super().__init__(*args, **kwargs)
        wakes = []
        fake_module = types.SimpleNamespace(Gateway=FlakyGateway,
            fetch_session_info=lambda cookies: {"vm_id": "vm-original", "vm_state": "RUNNING"},
            fetch_access_token=lambda cookies: "access", fetch_hatch_token=lambda *args: "hatch")
        with patch.dict(sys.modules, {"muse_cli.gateway": fake_module}), patch.object(worker.importlib.metadata, "version", return_value="0.3.10"), patch.object(worker.time, "sleep"), patch.object(worker, "post_wake", lambda *args: wakes.append(args[-1]) or 200):
            result = worker.dispatch("initialize", {"cookies": "hatch_sess=dedicated"})
        self.assertEqual(calls["n"], 2)
        self.assertEqual(wakes, ["vm-original"])
        self.assertEqual(result["initialized"], True)

    def test_websocket_502_is_a_gateway_problem_and_unknown_vm_state_does_not_connect(self):
        CurlError = type("CurlError", (OSError,), {})
        public = worker.public_failure(CurlError("wss://hatch.example/noise?auth_token=secret Refused WebSocket upgrade: 502"), "gateway")
        self.assertEqual(public["code"], "gateway_unavailable")
        self.assertEqual(public["stage"], "gateway")
        self.assertNotIn("secret", json.dumps(public))
        fake_module = types.SimpleNamespace(
            fetch_session_info=lambda cookies: {"vm_id": "vm-original", "vm_state": "ERROR"},
            fetch_access_token=lambda cookies: "access",
            Gateway=lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("gateway opened")))
        with patch.dict(sys.modules, {"muse_cli.gateway": fake_module}), patch.object(worker.importlib.metadata, "version", return_value="0.3.10"):
            with self.assertRaises(worker.PublicGatewayError) as caught:
                worker.dispatch("initialize", {"cookies": "hatch_sess=dedicated"})
        self.assertEqual(caught.exception.diagnostic["stage"], "wake")
        self.assertEqual(caught.exception.diagnostic["code"], "vm_unavailable")

    def test_unknown_exception_names_are_not_a_public_diagnostic_channel(self):
        ArbitraryError = type("private-token-in-class-name", (RuntimeError,), {})
        public = worker.public_failure(ArbitraryError("private-payload"))
        self.assertEqual(public["kind"], "RuntimeError")
        self.assertNotIn("private-", json.dumps(public))


if __name__ == "__main__":
    unittest.main()
