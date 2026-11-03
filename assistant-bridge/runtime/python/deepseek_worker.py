"""AntDesk's private stdio boundary around the pinned, official DeepSeek SDK.

Credentials arrive only through stdin and are never returned, logged or written.
The official SDK owns model transport, history, the agent loop and shutdown.
"""
from __future__ import annotations

import importlib.metadata
import json
import sys
import threading
from pathlib import Path

SDK_VERSION = "0.2.1rc2"
WRITE_LOCK = threading.Lock()
STATE_LOCK = threading.Lock()
LIFECYCLE_LOCK = threading.RLock()
HARNESS = None
RUNNING = False
STOPPED = False
REQUESTS: dict[str, object] = {}
PUBLIC_ERROR_CODES = frozenset({
    "ACCOUNT_SIGN_IN_REQUIRED", "ACCOUNT_TOKEN_INVALID", "ACCOUNT_QUOTA",
    "CLIENT_UPGRADE_REQUIRED", "MODEL_UNSUPPORTED", "MISSING_CREDENTIAL",
    "INVALID_CREDENTIAL", "AUTHENTICATION", "AUTH", "PERMISSION", "QUOTA",
    "RATE_LIMIT", "MODEL_NOT_FOUND", "NETWORK", "TIMEOUT", "TRANSPORT",
    "SERVER", "CONTEXT_WINDOW_EXCEEDED", "INVALID_REQUEST", "EMPTY_RESPONSE",
})


def public_error_code(value, depth: int = 0) -> str | None:
    """Only documented error categories can cross the private worker boundary.

    Do not serialize exception messages, model input, headers, or stderr. A
    nested known category is useful even when the SDK wraps it in a generic
    transport/JSON-RPC error.
    """
    if depth > 5:
        return None
    if isinstance(value, BaseException):
        for field in ("code", "data", "failure", "__cause__"):
            found = public_error_code(getattr(value, field, None), depth + 1)
            if found:
                return found
    if isinstance(value, str):
        return value if value in PUBLIC_ERROR_CODES else None
    if isinstance(value, dict):
        for field in ("code", "kind", "failure", "error", "cause", "reason", "data"):
            found = public_error_code(value.get(field), depth + 1)
            if found:
                return found
    return None


def output(value: dict) -> None:
    with WRITE_LOCK:
        sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def notify(method: str, params: dict) -> None:
    output({"jsonrpc": "2.0", "method": method, "params": params})


def request_loop(harness) -> None:
    while not STOPPED:
        try:
            request = harness.client.next_request()
        except Exception:
            return
        # This SDK version has no built-in interactive tools in our safe profile.
        # Surface an unexpected request; never grant permission automatically.
        request_key = str(request.id)
        REQUESTS[request_key] = request
        notify("runtime/request", {"requestId": request_key, "method": request.method, "payload": request.payload})


def initialize(params: dict) -> dict:
    global HARNESS, STOPPED
    if HARNESS is not None:
        raise RuntimeError("Already initialized")
    if importlib.metadata.version("deepseek-harness-sdk") != SDK_VERSION:
        raise RuntimeError("Unsupported official SDK version")
    if importlib.metadata.version("deepseek-harness-runtime-bin") != SDK_VERSION:
        raise RuntimeError("Unsupported official runtime version")
    from deepseek_harness import DeepSeekHarness, DeepSeekHarnessConfig

    home = Path(params["home"]).resolve()
    cwd = Path(params["cwd"]).resolve()
    patch = Path(params["patchPath"]).resolve()
    home.mkdir(parents=True, exist_ok=True)
    cwd.mkdir(parents=True, exist_ok=True)
    if not patch.is_file():
        raise RuntimeError("Required assistant safety profile is missing")
    auth_mode = params.get("authMode", "api_key")
    if auth_mode not in {"account", "api_key"}:
        raise RuntimeError("Unsupported authentication mode")
    if auth_mode == "api_key" and not params.get("apiKey"):
        raise RuntimeError("Missing API credential")
    config = DeepSeekHarnessConfig(
        provider="deepseek-account" if auth_mode == "account" else "deepseek-official",
        model=params.get("model") or ("deepseek-flash" if auth_mode == "account" else "deepseek-v4-flash"),
        cwd=str(cwd), runtime_cwd=str(cwd), dsh_home=str(home),
        profile="sdk-minimal", patches=(str(patch),),
        api_key=params.get("apiKey") if auth_mode == "api_key" else None, base_url=params.get("baseUrl"),
        initialize_timeout_seconds=30.0, request_timeout_seconds=30.0,
        shutdown_timeout_seconds=1.0,
        env={"DSH_SYSTEM_PROMPT": "You are a helpful task-planning assistant in AntDesk. Help the user plan and review their tasks. No shell, filesystem, or working-directory tools are available. Do not claim to have executed actions you cannot perform."},
    )
    HARNESS = DeepSeekHarness(config)
    HARNESS.start()
    STOPPED = False
    threading.Thread(target=request_loop, args=(HARNESS,), daemon=True).start()
    return {"sdkVersion": SDK_VERSION, "runtimeVersion": SDK_VERSION, "initialized": True}


def run_session(params: dict) -> dict:
    global RUNNING
    harness = HARNESS
    if harness is None or STOPPED:
        raise RuntimeError("Runtime not initialized")
    with STATE_LOCK:
        if RUNNING:
            raise RuntimeError("A run is already active")
        RUNNING = True
    session_id = params["sessionId"]
    accepted = False
    failure_code = None

    def collect(notification) -> None:
        nonlocal accepted, failure_code
        payload = notification.payload
        if not accepted and notification.method == "session.event" and payload.get("sessionId") == session_id:
            event = payload.get("event", {})
            if event.get("type") == "agent/inbox/spliced":
                inserted = event.get("data", {}).get("inserted", [])
                # The SDK begins this callback at this run's own inbox receipt.
                message_id = next((entry.get("id") for entry in inserted if isinstance(entry, dict) and entry.get("id")), None)
                if message_id:
                    accepted = True
                    notify("run/accepted", {"sessionId": session_id, "messageId": message_id})
        if notification.method == "session.event" and payload.get("sessionId") == session_id:
            event = payload.get("event", {})
            if event.get("type") == "turn/end":
                failure_code = public_error_code(event.get("data"))
        notify("runtime/notification", {"method": notification.method, "payload": payload})

    try:
        session = harness.resume_session(session_id) if params.get("resume") else harness.start_session(session_id)
        result = session.run(params["input"], on_notification=collect)
        return {"sessionId": result.session_id, "finalResponse": result.final_response,
                "finishReason": result.finish_reason, "accepted": accepted,
                **({"errorCode": failure_code} if failure_code else {})}
    finally:
        with STATE_LOCK:
            RUNNING = False


def stop_runtime() -> dict:
    global STOPPED
    STOPPED = True
    with LIFECYCLE_LOCK:
        if HARNESS is not None:
            HARNESS.close()  # Official shutdown RPC, bounded terminate/kill and process reap.
    REQUESTS.clear()
    return {"stopped": True}


def dispatch(method: str, params: dict) -> dict:
    if method == "initialize":
        with LIFECYCLE_LOCK:
            return initialize(params)
    if method == "session/run":
        return run_session(params)
    if method == "session/recover":
        if HARNESS is None or STOPPED:
            raise RuntimeError("Runtime not initialized")
        session = HARNESS.resume_session(params["sessionId"])
        # No prompt is sent. The SDK restores history and repairs interrupted tails.
        return {"sessionId": session.id, "restored": True}
    if method == "request/respond":
        request = REQUESTS.get(params["requestId"])
        if request is None:
            raise RuntimeError("Request is no longer pending")
        # Fail closed on unsupported host requests. This is never an approval grant.
        HARNESS.client.respond_error(request.id, code=-32601, message="This client cannot fulfill this request. Continue without the operation.")
        REQUESTS.pop(params["requestId"], None)
        return {"ok": True, "declined": True}
    if method in {"stop", "shutdown"}:
        return stop_runtime()
    raise RuntimeError("Unsupported worker request")


def handle(message: dict) -> None:
    request_id = message.get("id")
    try:
        result = dispatch(message["method"], message.get("params") or {})
        output({"jsonrpc": "2.0", "id": request_id, "result": result})
    except Exception as error:
        # SDK exceptions may contain retained upstream stderr. Never return their text.
        category = type(error).__name__
        output({"jsonrpc": "2.0", "id": request_id, "error": {
            "code": -32000, "message": "Official DeepSeek runtime request did not complete.",
            "data": {"kind": category, "stopped": STOPPED,
                     **({"runtimeCode": code} if (code := public_error_code(error)) else {})},
        }})


def main() -> None:
    try:
        for line in sys.stdin:
            if len(line) > 2 * 1024 * 1024:
                break
            try:
                message = json.loads(line)
                if not isinstance(message, dict) or not isinstance(message.get("method"), str):
                    continue
            except (ValueError, TypeError):
                continue
            # The reader remains live during a run so stop/decline can be delivered.
            threading.Thread(target=handle, args=(message,), daemon=True).start()
    finally:
        stop_runtime()


if __name__ == "__main__":
    main()
