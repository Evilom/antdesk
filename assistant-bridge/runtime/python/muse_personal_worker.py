"""Private stdio boundary for the pinned community muse-cli gateway.

This worker never discovers browser profiles, reads cookies from disk, or invokes
muse_cli.cli/auth export. Its caller owns dedicated-browser login and encrypted
credential storage. Cookies are supplied only in the initialize stdin message.
"""
from __future__ import annotations

import importlib.metadata
import json
import re
import sys
import threading
import time

SDK_VERSION = "0.3.10"
WRITE_LOCK = threading.Lock()
GATEWAY_LOCK = threading.RLock()
# A suspended personal VM accepts session and hatch tokens, then refuses the
# gateway WebSocket with HTTP 502. Wake it and wait until the instance is up.
ASLEEP_STATES = {"SUSPENDED", "SLEEPING", "ASLEEP", "STOPPED", "HIBERNATED", "SUSPENDING"}
STARTING_STATES = {"STARTING", "BOOTING", "PROVISIONING", "PENDING", "WAKING", "RESUMING"}
READY_STATES = {"", "RUNNING", "READY", "ACTIVE", "ONLINE", "STARTED", "UP"}
WAKE_POLLS = 12
WAKE_INTERVAL_SECONDS = 3
GATEWAY_ATTEMPTS = 4
GATEWAY_INTERVAL_SECONDS = 3
GATEWAY = None
ACCOUNT = None
STOPPED = False
SENT_RUNS: set[str] = set()

# These categories are the entire public diagnostic surface. The community SDK
# includes response bodies and token-bearing URLs in some exceptions, so neither
# exception text nor arbitrary class names may cross the stdio boundary.
PUBLIC_KINDS = {"AuthError", "GatewayError", "TimeoutError", "ConnectionError",
                "RuntimeError", "ValueError", "JSONDecodeError", "KeyError",
                "ModuleNotFoundError", "PackageNotFoundError", "NetworkError"}
TIMEOUT_KINDS = {"TimeoutError", "Timeout", "ReadTimeout", "ConnectTimeout", "WebSocketTimeout"}
NETWORK_KINDS = {"ConnectionError", "DNSError", "ProxyError", "SSLError", "CertificateVerifyError",
                 "CurlError", "RequestException", "RequestsError", "WebSocketError", "OSError"}


class PublicGatewayError(RuntimeError):
    def __init__(self, diagnostic):
        super().__init__("Muse gateway request did not complete.")
        self.diagnostic = diagnostic


def public_failure(failure, stage="runtime") -> dict:
    if isinstance(failure, PublicGatewayError):
        return failure.diagnostic
    kind = type(failure).__name__
    status = getattr(failure, "status", None)
    if not isinstance(status, int) or isinstance(status, bool) or not 100 <= status <= 599:
        status = None
    # Pinned muse-cli 0.3.10 throws AuthError even for throttling/5xx. Match
    # only its fixed prefix and numeric status, never return the appended body.
    if kind == "AuthError":
        match = re.match(r"^(api/session|auth/check|hatch/token) -> ([1-5][0-9]{2})(?:\s|$)", str(failure))
        if match:
            status = int(match[2])
            stage = {"api/session": "session", "auth/check": "authorization", "hatch/token": "gateway_token"}[match[1]]
        elif str(failure).startswith("api/session returned non-JSON"):
            return {"kind": kind, "stage": "session", "code": "invalid_response", "httpStatus": 200, "retryable": True}
    code, retryable = "gateway_error", False
    if status == 401:
        code = "auth_required"
    elif status == 403:
        code = "access_denied"
    elif status == 429:
        code, retryable = "rate_limited", True
    elif status in {408, 425} or (status is not None and status >= 500):
        code, retryable = "service_unavailable", True
    elif kind == "GatewayError" and getattr(failure, "status", None) == -1 and str(getattr(failure, "payload", "")).startswith("VM unavailable ("):
        code, retryable = "vm_unavailable", True
        stage = "session"
    elif kind in TIMEOUT_KINDS or (kind in NETWORK_KINDS and getattr(failure, "code", None) == 28):
        code, retryable, kind = "network_timeout", True, "TimeoutError"
    elif kind in NETWORK_KINDS and "WebSocket upgrade: 502" in str(failure):
        # The fixed curl phrase identifies a suspended gateway. The rest of the
        # exception can carry the signed socket URL, so it is never returned.
        code, retryable, stage = "gateway_unavailable", True, "gateway"
    elif kind in NETWORK_KINDS:
        code, retryable, kind = "network_error", True, "NetworkError"
    elif kind in {"JSONDecodeError", "KeyError"}:
        code, retryable = "invalid_response", True
    elif kind in {"ModuleNotFoundError", "PackageNotFoundError"}:
        code = "runtime_unavailable"
    elif kind == "AuthError" and status is None:
        code = "auth_required"
    elif kind == "GatewayError" and getattr(failure, "status", None) == -1:
        code, retryable = "gateway_unavailable", True
    result = {"kind": kind if kind in PUBLIC_KINDS else "RuntimeError",
              "stage": stage, "code": code, "retryable": retryable}
    if status is not None:
        result["httpStatus"] = status
    return result


def at_stage(stage, operation):
    try:
        return operation()
    except Exception as failure:
        raise PublicGatewayError(public_failure(failure, stage)) from None


def identifier(value, name="identifier") -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}", value):
        raise ValueError("Invalid " + name)
    return value


def text(value, maximum=262144) -> str:
    return value[:maximum] if isinstance(value, str) else ""


def vm_state(info) -> str:
    value = info.get("vm_state") if isinstance(info, dict) else None
    return value.strip().upper() if isinstance(value, str) else ""


def post_wake(sdk, cookies, access_token, vm_id) -> int:
    from curl_cffi import requests as client
    response = client.post(
        "https://muse.ai/api/hatch/vm/wake",
        headers=sdk._hatch_headers(cookies, access_token),
        json={"vm_id": vm_id, "retry_count": 0},
        impersonate="chrome", timeout=20,
    )
    if not 200 <= response.status_code <= 299:
        failure = RuntimeError("Muse wake did not complete.")
        failure.status = response.status_code
        raise failure
    return response.status_code


def prepare_vm(sdk, cookies, access_token, info) -> dict:
    state = vm_state(info)
    if state in READY_STATES:
        return info
    woken = False
    if state in ASLEEP_STATES:
        at_stage("wake", lambda: post_wake(sdk, cookies, access_token, info["vm_id"]))
        woken = True
    elif state not in STARTING_STATES:
        raise PublicGatewayError({"kind": "GatewayError", "stage": "wake", "code": "vm_unavailable", "retryable": True})
    for _ in range(WAKE_POLLS):
        time.sleep(WAKE_INTERVAL_SECONDS)
        info = at_stage("session", lambda: sdk.fetch_session_info(cookies))
        state = vm_state(info)
        if state in READY_STATES:
            return info
        if state in ASLEEP_STATES and not woken:
            at_stage("wake", lambda: post_wake(sdk, cookies, access_token, info["vm_id"]))
            woken = True
    raise PublicGatewayError({"kind": "GatewayError", "stage": "wake", "code": "vm_unavailable", "retryable": True})


def transient_gateway(failure) -> bool:
    status = getattr(failure, "status", None)
    if status in {502, 503, 504}:
        return True
    return "WebSocket upgrade: 502" in str(failure) or "WebSocket upgrade: 503" in str(failure)


def open_gateway(sdk, cookies, vm_id, access_token, hatch_token):
    failure = None
    woke = False
    for attempt in range(GATEWAY_ATTEMPTS):
        try:
            return sdk.Gateway(cookies, vm_id=vm_id, access_token=access_token, hatch_token=hatch_token)
        except Exception as error:
            failure = error
            if attempt + 1 == GATEWAY_ATTEMPTS or not transient_gateway(error):
                raise
            # The control plane can report RUNNING while the socket still
            # refuses the upgrade. One wake covers that gap.
            if not woke:
                post_wake(sdk, cookies, access_token, vm_id)
                woke = True
            time.sleep(GATEWAY_INTERVAL_SECONDS)
    raise failure


def public_account(identity, vm_id) -> dict:
    identity = identity if isinstance(identity, dict) else {}
    candidates = [identity.get("name"), identity.get("display_name"), identity.get("displayName")]
    agent = identity.get("agent") or identity.get("assistant")
    if isinstance(agent, dict):
        candidates.extend([agent.get("name"), agent.get("display_name")])
    name = next((item for item in candidates if isinstance(item, str) and item.strip()), "我的 Muse")
    return {"id": identifier(vm_id, "personal VM"), "name": text(name, 160)}


def initialize(params: dict) -> dict:
    global GATEWAY, ACCOUNT, STOPPED
    if GATEWAY is not None:
        raise RuntimeError("Already initialized")
    if importlib.metadata.version("muse-cli") != SDK_VERSION:
        raise RuntimeError("Unsupported Muse community SDK version")
    cookies = params.get("cookies")
    if not isinstance(cookies, str) or not cookies or len(cookies) > 65536 or any(c in cookies for c in "\r\n\0"):
        raise ValueError("A dedicated Muse browser session is required")
    # Import only the protocol library; never the CLI/browser credential helpers.
    sdk = importlib.import_module("muse_cli.gateway")

    # Use the pinned SDK's actual steps so login diagnostics distinguish a
    # valid browser login whose personal VM is starting from rejected cookies.
    info = at_stage("session", lambda: sdk.fetch_session_info(cookies))
    vm_id = identifier(info["vm_id"], "personal VM")
    access_token = at_stage("authorization", lambda: sdk.fetch_access_token(cookies))
    info = prepare_vm(sdk, cookies, access_token, info)
    vm_id = identifier(info["vm_id"], "personal VM")
    hatch_token = at_stage("gateway_token", lambda: sdk.fetch_hatch_token(cookies, access_token, vm_id))
    gateway = at_stage("gateway", lambda: open_gateway(sdk, cookies, vm_id, access_token, hatch_token))
    try:
        account = at_stage("identity", lambda: public_account(gateway.call_json("identity"), gateway.vm_id))
    except Exception:
        gateway.close()
        raise
    GATEWAY, ACCOUNT, STOPPED = gateway, account, False
    return {"initialized": True, "sdkVersion": SDK_VERSION, "account": account}


def normalized_history(data: dict) -> dict:
    if not isinstance(data, dict) or not isinstance(data.get("chat_events"), list):
        raise ValueError("Invalid Muse history")
    events = []
    max_seq = 0
    for event in data["chat_events"]:
        if not isinstance(event, dict):
            continue
        seq = event.get("seq")
        if not isinstance(seq, int) or isinstance(seq, bool) or seq < 0:
            continue
        max_seq = max(max_seq, seq)
        kind = event.get("event_name")
        if kind not in {"message.user", "message.assistant"}:
            continue
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        events.append({"seq": seq, "role": "user" if kind == "message.user" else "assistant",
                       "text": text(payload.get("display_text") or payload.get("content"), 131072),
                       "status": text(payload.get("status"), 80),
                       "messageId": text(payload.get("message_id") or event.get("message_id"), 256),
                       "replyTo": text(payload.get("reply_to_message_id") or event.get("reply_to_message_id"), 256)})
    if len(events) > 512:
        raise ValueError("Muse history exceeds the bounded query")
    return {"events": sorted(events, key=lambda event: event["seq"]), "maxSeq": max_seq}


def dispatch(method: str, params: dict) -> dict:
    global STOPPED
    if method == "shutdown":
        STOPPED = True
        if GATEWAY is not None:
            GATEWAY.close()
        return {"closed": True, "remoteStopped": False}
    with GATEWAY_LOCK:
        if method == "initialize":
            return initialize(params)
        if GATEWAY is None or STOPPED:
            raise RuntimeError("Muse gateway is not connected")
        if method == "account/read":
            return {"account": ACCOUNT}
        if method == "sessions/list":
            result = GATEWAY.call_json("sessions.list")
            if not isinstance(result, dict) or not isinstance(result.get("sessions"), list):
                raise ValueError("Invalid Muse sessions")
            sessions = []
            for item in result["sessions"][:1000]:
                if not isinstance(item, dict) or item.get("archived"):
                    continue
                session_id = item.get("session_id")
                try:
                    identifier(session_id, "session")
                except ValueError:
                    continue
                sessions.append({"id": session_id, "sessionId": session_id,
                                 "name": text(item.get("title"), 200) or "Muse 会话",
                                 "updatedAt": item.get("updated_at_ms") if isinstance(item.get("updated_at_ms"), int) else 0})
            return {"sessions": sessions}
        if method == "session/create":
            # This documented CLI body makes a separate side conversation on the
            # same personal VM. Never fall back to the user's main conversation.
            result = GATEWAY.call_json("session.start", body={
                "method": "/api/session/start", "params": {"origin": "fresh", "lifecycle": "persistent"}})
            session_id = identifier(result.get("session_id") or result.get("id"), "session")
            return {"sessionId": session_id}
        if method == "session/rename":
            session_id = identifier(params.get("sessionId"), "session")
            title = text(params.get("title"), 200)
            GATEWAY.call_json("session.rename", body={"session_id": session_id, "title": title})
            return {"renamed": True}
        if method == "history/read":
            session_id = identifier(params.get("sessionId"), "session")
            limit = params.get("limit", 256)
            if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 512:
                raise ValueError("Invalid history limit")
            return normalized_history(GATEWAY.call_json("chat.history", body={"session_id": session_id, "limit": limit}))
        if method == "chat/send":
            session_id = identifier(params.get("sessionId"), "session")
            run_id = identifier(params.get("runId"), "run")
            node_id = identifier(params.get("nodeId"), "node")
            message = params.get("text")
            if not isinstance(message, str) or not message.strip() or len(message.encode("utf-8")) > 400000:
                raise ValueError("Invalid Muse task text")
            if run_id in SENT_RUNS:
                raise RuntimeError("This worker already attempted this task")
            # Reserve before the network call. A broken connection cannot turn
            # the same worker into a second sender after an uncertain delivery.
            SENT_RUNS.add(run_id)
            GATEWAY._open("chat.stream", body={"session_id": session_id,
                "items": [{"type": "text", "text": message}], "node_id": node_id, "capabilities": {}})
            # The local stream number is not a durable server task handle, and
            # writing bytes is not a server receipt. History must confirm it.
            return {"submitted": True, "accepted": False}
        if method == "chat/cancel":
            # A capability/route name without a proven body and acknowledgement
            # is insufficient to promise that the personal Bot was stopped.
            return {"remoteStopped": False, "supported": False}
        raise ValueError("Unsupported Muse worker method")


def output(value: dict) -> None:
    with WRITE_LOCK:
        sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def handle(message: dict) -> None:
    request_id = message.get("id")
    try:
        params = message.get("params") or {}
        if not isinstance(params, dict):
            raise ValueError("Invalid request parameters")
        result = dispatch(message["method"], params)
        output({"jsonrpc": "2.0", "id": request_id, "result": result})
    except Exception as error:
        # Gateway exceptions may include response payloads or token-bearing URLs.
        # Expose a category only, never their message, traceback or SDK stderr.
        output({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32000,
            "message": "Muse personal gateway request did not complete.", "data": public_failure(error)}})


def main() -> None:
    try:
        for line in sys.stdin:
            if len(line) > 1024 * 1024:
                break
            try:
                message = json.loads(line)
                if not isinstance(message, dict) or not isinstance(message.get("method"), str):
                    continue
            except (ValueError, TypeError):
                continue
            threading.Thread(target=handle, args=(message,), daemon=True).start()
    finally:
        dispatch("shutdown", {})


if __name__ == "__main__":
    main()
