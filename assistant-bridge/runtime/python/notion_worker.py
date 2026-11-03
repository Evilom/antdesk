"""Single-account stdio bridge to the pinned maverickxone/notion2api client.

Credentials arrive through stdin from AntDesk's sealed store. This worker never
loads accounts.json, .env, browser profiles or the upstream web/admin server.
Only explicit chat/send can create an AI thread; discovery and recovery read.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from pathlib import Path
import re
import sys
import threading
import time

UPSTREAM_COMMIT = "cc7fcf4dc78af245f4ce961c5951384c7b78b005"
SOURCE_HASHES = {
    "app/__init__.py": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "app/notion_client.py": "906ca8148bc58e9a8e08c948e2906516fe1790a66f34305b0eba37099c1aab17",
    "app/model_registry.py": "54794a9d96b39a0cdbcd4d5697356c71d9c578ad4c9567f7f420aea57cdfb476",
    "app/stream_parser.py": "e54bfa8dbafa0985e0c2445acff282dd413cf59a64b1e522ccdb0e61fe5beee5",
    "app/logger.py": "7742ba6fafd07d17b49effa094d22eaf9add8941cbe1c2310ca51c081710ada8",
}
ORIGIN = "https://www.notion.so"
MAX_REPLY = 262144
ACCOUNT = None
CLIENT = None
MODULE = None
CREDENTIALS = None
WORKSPACES = []
MODELS = []
MODELS_SOURCE = "unavailable"
STOP = threading.Event()
WRITE_LOCK = threading.Lock()
CALL_LOCK = threading.Lock()
SENT = set()


class SafeError(RuntimeError):
    def __init__(self, code, status=None, stage="runtime"):
        super().__init__("Notion request did not complete.")
        self.code, self.status, self.stage = code, status, stage


def public_failure(error, stage="runtime"):
    status = getattr(error, "status", None) or getattr(error, "status_code", None)
    if not isinstance(status, int) or isinstance(status, bool) or not 100 <= status <= 599:
        status = None
    allowed = {"auth_required", "account_ambiguous", "workspace_unavailable", "workspace_mismatch", "account_mismatch",
               "access_denied", "credits_exhausted", "rate_limited", "service_unavailable", "network_timeout",
               "network_error", "invalid_response", "runtime_unavailable", "runtime_version_mismatch", "model_unavailable",
               "approval_required", "incomplete_response", "ambiguous_response", "thread_missing", "already_sent", "cancelled", "request_too_large"}
    if isinstance(error, SafeError) and error.code in allowed:
        code, stage = error.code, error.stage
    elif status == 401:
        code = "auth_required"
    elif status == 402:
        code = "credits_exhausted"
    elif status == 403:
        code = "access_denied"
    elif status == 429:
        code = "rate_limited"
    elif status and status >= 500:
        code = "service_unavailable"
    elif type(error).__name__ in {"Timeout", "TimeoutError", "ReadTimeout", "ConnectTimeout"}:
        code = "network_timeout"
    elif type(error).__name__ in {"ModuleNotFoundError", "ImportError", "FileNotFoundError"}:
        code = "runtime_unavailable"
    else:
        code = "network_error" if type(error).__name__ in {"ConnectionError", "CurlError", "RequestException", "RequestsError"} else "invalid_response"
    result = {"code": code, "stage": stage, "retryable": code in {"rate_limited", "service_unavailable", "network_timeout", "network_error"}}
    if status:
        result["httpStatus"] = status
    return result


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}", value):
        raise SafeError("invalid_response")
    return value


def clipped(value, maximum=MAX_REPLY):
    return value[:maximum] if isinstance(value, str) else ""


def cookie_values(header):
    if not isinstance(header, str) or not header or len(header) > 32768 or re.search(r"[\r\n\x00]", header):
        raise SafeError("auth_required", stage="authorization")
    values = {}
    for part in header.split(";"):
        name, sep, value = part.strip().partition("=")
        if not sep or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name) or not value or re.search(r"[\x00-\x20\x7f;,\\]", value):
            raise SafeError("auth_required", stage="authorization")
        if name in values and values[name] != value:
            # token and user id identify the account. Host cookies such as
            # __cf_bm differ between notion.so and notion.com.
            if name in {"token_v2", "notion_user_id"}:
                raise SafeError("account_ambiguous", stage="authorization")
            continue
        values[name] = value
    if not values.get("token_v2"):
        raise SafeError("auth_required", stage="authorization")
    return values


def load_upstream(source):
    global MODULE
    root = Path(source).resolve()
    for name, expected in SOURCE_HASHES.items():
        content = (root / name).read_text(encoding="utf-8")
        if hashlib.sha256(content.encode()).hexdigest() != expected:
            raise SafeError("runtime_version_mismatch")
    # The endpoint, transport and no-cleanup behavior are pinned. Environment
    # variables from unrelated applications cannot redirect an account cookie.
    for name in list(os.environ):
        if name.startswith("NOTION_") or name in {"AGENT_SERVICE_DELETE_THREAD", "AGENT_SERVICE_TIMEOUT_S"}:
            os.environ.pop(name, None)
    os.environ.update(NOTION_URL=ORIGIN, NOTION_RUNTIME="agent_service", AGENT_SERVICE_DELETE_THREAD="false", AGENT_SERVICE_TIMEOUT_S="240")
    sys.path.insert(0, str(root))
    from app import notion_client
    notion_client.logger.disabled = True
    logging.disable(logging.CRITICAL)
    if notion_client.cffi_requests is None:
        # Do not fall back to cloudscraper's automatic challenge handling. A
        # missing pinned transport is an installation problem, not permission
        # to solve or bypass a verification wall.
        raise SafeError("runtime_unavailable")
    MODULE = notion_client
    return notion_client


def response_ok(response, stage="identity"):
    if response.status_code != 200:
        code = {401: "auth_required", 402: "credits_exhausted", 403: "access_denied", 429: "rate_limited", 404: "thread_missing"}.get(response.status_code, "service_unavailable" if response.status_code >= 500 else "invalid_response")
        if response.status_code == 400:
            # Use only recognized error markers, never return upstream bodies
            # which may contain account data, page content or credentials.
            material = clipped(getattr(response, "text", ""), 8192).lower()
            if any(term in material for term in ("quota_exceeded", "insufficient_quota", "credits_exhausted", "usage_limit", "ai_limit")):
                code = "credits_exhausted"
            elif any(term in material for term in ("does not support selected model", "model_not_available", "unsupported_model")):
                code = "model_unavailable"
            elif any(term in material for term in ("device_verification", "verification_required", "challenge_required")):
                code = "access_denied"
        raise SafeError(code, response.status_code, stage)
    return response


def value(row):
    if not isinstance(row, dict):
        return {}
    return row.get("value") if isinstance(row.get("value"), dict) else row


def discover_accounts(data, cookies):
    """Use server-returned user/workspace grouping; never pair unrelated users."""
    groups = []
    if isinstance(data, dict):
        if isinstance(data.get("recordMap"), dict):
            groups.append(data["recordMap"])
        elif "notion_user" in data:
            groups.append(data)
        else:
            groups.extend(group for group in data.values() if isinstance(group, dict) and "notion_user" in group)
    candidates = []
    for group in groups:
        users = group.get("notion_user") or {}
        spaces = group.get("space") or {}
        views = {}
        for view_id, row in (group.get("space_view") or {}).items():
            v = value(row)
            if v.get("space_id"):
                views[str(v["space_id"])] = str(view_id)
        if not isinstance(users, dict) or not isinstance(spaces, dict):
            continue
        for user_id, raw in users.items():
            u = value(raw)
            if u.get("deleted") is True:
                continue
            for space_id, raw_space in spaces.items():
                s = value(raw_space)
                if s.get("alive") is False:
                    continue
                candidates.append({"user_id": identifier(str(user_id)), "user_name": clipped(u.get("name") or u.get("given_name") or "我的 Notion", 160),
                    "user_email": clipped(u.get("email"), 320), "space_id": identifier(str(space_id)), "space_view_id": views.get(str(space_id), ""),
                    "workspace_name": clipped(s.get("name") or "Notion 工作区", 160)})
    identities = {c["user_id"] for c in candidates}
    active_user = cookies.get("notion_user_id", "")
    if active_user in identities:
        candidates = [c for c in candidates if c["user_id"] == active_user]
    elif len(identities) > 1:
        raise SafeError("account_ambiguous", stage="identity")
    if not candidates:
        raise SafeError("workspace_unavailable", stage="workspace")
    return list({(c["user_id"], c["space_id"]): c for c in candidates}.values())


# Notion's catalog uses internal codenames. The picker shows the product name.
CODENAME_NAMES = {
    "albuquerque-quinn": "Opus 5.5",
    "achira-donut": "Sonnet 5.5",
    "amla-jam": "Haiku 5.5",
    "avocado-froyo-medium": "Opus 4.6",
    "apricot-sorbet-high": "Opus 4.7",
    "ambrosia-tart-high": "Opus 4.8",
    "agave-flan": "Opus 5",
    "almond-croissant-low": "Sonnet 4.6",
    "angel-cake-high": "Sonnet 5",
    "anthropic-haiku-4.5": "Haiku 4.5",
    "orlando-quinn": "GPT-6 Astra",
    "omniberry-sundae": "GPT-6.1 Sol",
    "omodi": "GPT-6 Luna",
    "orchid-muffin": "GPT-5.6 Terra",
    "olive-jellyroll": "GPT-5.6 Luna",
    "orange-mousse": "GPT-5.6 Sol",
    "oval-kumquat-medium": "GPT-5.4",
    "opal-quince-medium": "GPT-5.5",
    "oregon-grape-medium": "GPT-5.4 Mini",
    "otaheite-apple-medium": "GPT-5.4 Nano",
    "vertex-gemini-3.5-flash": "Gemini 3.5 Flash",
    "vertex-gemini-3.6-flash": "Gemini 3.6 Flash",
    "grapefruit-zeppole": "Gemini 3.7 Flash",
    "galette-medium-thinking": "Gemini 3.1 Pro",
    "gingerbread": "Gemini 3 Flash",
    "fireworks-kimi-k3": "Kimi K3",
    "baseten-deepseek-v4-pro": "DeepSeek V4 Pro",
    "baseten-deepseek-v4-flash": "DeepSeek V4 Flash",
    "baseten-glm-5.2": "GLM 5.2",
    "xigua-mochi-medium": "Grok 4.3",
    "strawberry-whoopiepie": "SpaceXAI 4.5",
    "xinomavro-cake": "Grok Build 0.1",
    "acai-budino-high": "Fable 5",
    "grok-4.7": "Grok 4.7",
}


def discover_models(data):
    if not isinstance(data, dict):
        return []
    rows = data.get("models") or data.get("availableModels") or []
    if isinstance(rows, dict):
        rows = [{**v, "id": k} if isinstance(v, dict) else {"id": k, "name": v} for k, v in rows.items()]
    if not isinstance(rows, list):
        return []
    result = []
    for row in rows:
        if not isinstance(row, dict) or any(row.get(key) is False for key in ("available", "isAvailable", "enabled", "isEnabled")):
            continue
        model = row.get("id") or row.get("model") or row.get("modelId") or row.get("name")
        if not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}", model):
            continue
        raw_name = row.get("displayName") or row.get("label") or row.get("name")
        label = raw_name if isinstance(raw_name, str) and raw_name and raw_name != model else CODENAME_NAMES.get(model, model)
        result.append({"id": model, "name": clipped(label, 160)})
    return list({m["id"]: m for m in result}.values())[:100]


def initialize(params):
    global ACCOUNT, CLIENT, CREDENTIALS, WORKSPACES, MODELS, MODELS_SOURCE
    module = load_upstream(params["source"])
    cookies = cookie_values(params.get("cookies"))
    session = module._new_http_session()
    headers = {"Content-Type": "application/json", "Cookie": "; ".join(f"{k}={v}" for k, v in cookies.items()), "Origin": ORIGIN,
               "Referer": ORIGIN + "/ai", "User-Agent": module.BROWSER_UA}
    try:
        response = response_ok(session.post(ORIGIN + "/api/v3/getSpaces", json={}, headers=headers, timeout=30, allow_redirects=False))
        try:
            candidates = discover_accounts(response.json(), cookies)
        except SafeError as failure:
            if failure.code != "workspace_unavailable":
                raise
            # The upstream login helper supports this older metadata shape.
            # Only a successful empty getSpaces response permits this bounded
            # read-only fallback; authentication/challenge failures never do.
            response = response_ok(session.post(ORIGIN + "/api/v3/loadUserContent", json={}, headers=headers, timeout=30, allow_redirects=False))
            candidates = discover_accounts(response.json(), cookies)
        selected = params.get("workspaceId")
        if selected and selected not in {c["space_id"] for c in candidates}:
            raise SafeError("workspace_mismatch", stage="workspace")
        chosen = next((c for c in candidates if c["space_id"] == selected), candidates[0] if len(candidates) == 1 else None)
        ACCOUNT = {"id": candidates[0]["user_id"], "name": candidates[0]["user_name"]}
        WORKSPACES = [{"id": c["space_id"], "name": c["workspace_name"]} for c in candidates]
        CREDENTIALS = {**(chosen or candidates[0]), "token_v2": cookies["token_v2"], "cookies": cookies}
        CLIENT = module.NotionOpusAPI(CREDENTIALS) if chosen else None
        MODELS, MODELS_SOURCE = [], "unavailable"
        if chosen:
            model_headers = {**headers, "x-notion-active-user-header": chosen["user_id"], "x-notion-space-id": chosen["space_id"]}
            try:
                response = response_ok(session.post(ORIGIN + "/api/v3/getAvailableModels", json={"spaceId": chosen["space_id"]}, headers=model_headers, timeout=20, allow_redirects=False), "models")
                MODELS = discover_models(response.json())
                MODELS_SOURCE = "account" if MODELS else "unavailable"
            except Exception as failure:
                if public_failure(failure)["code"] == "auth_required":
                    raise
                # A model catalog failure does not invent permission or make a
                # correctly authenticated account look logged out. Auto remains
                # the explicit default; actual AI entitlement is untested.
        return {"initialized": True, "sdkVersion": UPSTREAM_COMMIT, "account": ACCOUNT, "workspaces": WORKSPACES,
                "workspaceId": chosen["space_id"] if chosen else "", "models": MODELS, "modelsSource": MODELS_SOURCE}
    finally:
        session.close()


def write(message):
    with WRITE_LOCK:
        sys.stdout.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def notify(method, params):
    write({"jsonrpc": "2.0", "method": method, "params": params})


def extract_text(entity):
    content = entity.get("content")
    if not isinstance(content, list):
        return ""
    parts = []
    for item in content:
        if not isinstance(item, dict) or item.get("type") != "text":
            continue
        text = item.get("text")
        if isinstance(text, str):
            parts.append(text)
        elif isinstance(text, list):
            parts.extend(row[0] for row in text if isinstance(row, list) and row and isinstance(row[0], str))
    return "".join(parts)


def read_reply(response, run_id, thread_id, require_anchor=False):
    """Use upstream Agent Service schema, requiring a real completion event.

    Unlike upstream's EOF fallback, committed text without turn_completed is
    kept as a partial reply and never treated as a completed delivery.
    """
    committed, provisional = {}, {}
    anchor_seen = False
    deadline = time.monotonic() + 240
    for raw in response.iter_lines():
        if STOP.is_set():
            raise SafeError("cancelled")
        if time.monotonic() > deadline:
            raise SafeError("network_timeout", stage="response")
        if not raw:
            continue
        if len(raw) > 2 * 1024 * 1024:
            raise SafeError("invalid_response", stage="response")
        try:
            event = json.loads(raw)
        except (ValueError, TypeError):
            continue
        if not isinstance(event, dict) or event.get("type") == "keepalive":
            continue
        if event.get("type") in {"error", "unauthorized"}:
            raise SafeError("access_denied" if event.get("type") == "unauthorized" else "service_unavailable", stage="response")
        if event.get("type") != "agent_service_transcript_delta":
            continue
        for patch in event.get("patches") or []:
            if not isinstance(patch, dict):
                continue
            op = patch.get("op")
            if op == "patch":
                pid = str(patch.get("id") or "")
                if pid not in provisional:
                    continue
                for sub in patch.get("ops") or []:
                    if isinstance(sub, dict) and sub.get("op") == "append" and str(sub.get("path", "")).endswith("/text") and isinstance(sub.get("value"), str):
                        provisional[pid] += sub["value"]
                text = "\n\n".join(provisional.values())
                if len(text) > MAX_REPLY:
                    raise SafeError("request_too_large", stage="response")
                notify("notion/message", {"runId": run_id, "threadId": thread_id, "text": text, "complete": False})
                continue
            if op != "put" or not isinstance(patch.get("entity"), dict):
                continue
            entity = patch["entity"]
            kind = str(entity.get("kind") or "")
            eid = clipped(str(entity.get("id") or ""), 256)
            if kind == "user_message":
                user_text = extract_text(entity)
                if user_text:
                    if f"[AntDesk 事项 {run_id}]" in user_text:
                        anchor_seen = True
                    else:
                        raise SafeError("ambiguous_response", stage="response")
            elif kind == "assistant_message":
                text = extract_text(entity)
                if entity.get("source") == "provisional":
                    provisional[eid] = text
                    result = "\n\n".join(provisional.values())
                    notify("notion/message", {"runId": run_id, "threadId": thread_id, "text": clipped(result), "complete": False})
                elif text:
                    committed[eid] = text
            elif kind == "turn_completed":
                if require_anchor and not anchor_seen:
                    raise SafeError("ambiguous_response", stage="response")
                final = "\n\n".join(committed.values()) or "\n\n".join(provisional.values())
                if not final.strip():
                    raise SafeError("incomplete_response", stage="response")
                if len(final) > MAX_REPLY:
                    raise SafeError("request_too_large", stage="response")
                return {"completed": True, "text": final, "threadId": thread_id}
            elif "approval" in kind or "confirmation_request" in kind or kind == "requires_action":
                raise SafeError("approval_required", stage="response")
            elif "error" in kind or "failed" in kind:
                # The entity can contain account content. Classify it privately,
                # then return only the bounded public enum.
                material = json.dumps(entity, ensure_ascii=False).lower()
                if any(term in material for term in ("quota", "credit", "payment", "usage_limit", "ai_limit")):
                    code = "credits_exhausted"
                elif any(term in material for term in ("rate_limit", "too_many_requests")):
                    code = "rate_limited"
                elif any(term in material for term in ("unauthorized", "login_required", "not_logged_in")):
                    code = "auth_required"
                else:
                    code = "service_unavailable"
                raise SafeError(code, stage="response")
    raise SafeError("incomplete_response", stage="response")


def chat(params, recover=False):
    if CLIENT is None:
        raise SafeError("workspace_unavailable", stage="workspace")
    run_id = identifier(params.get("runId"))
    thread_id = identifier(params.get("threadId"))
    if params.get("accountId") != ACCOUNT["id"] or params.get("workspaceId") != CREDENTIALS["space_id"]:
        raise SafeError("account_mismatch", stage="identity")
    session, response = MODULE._new_http_session(), None
    try:
        headers = CLIENT._agent_headers()
        if not recover:
            if run_id in SENT:
                raise SafeError("already_sent")
            text = params.get("text")
            if not isinstance(text, str) or not text.strip() or len(text) > 200000:
                raise SafeError("request_too_large")
            model = params.get("model") or "auto"
            # Unknown model names must not silently fall back to a more costly
            # pinned model in the upstream registry.
            if model not in {"auto", "default"} and model not in {m["id"] for m in MODELS}:
                raise SafeError("model_unavailable", stage="models")
            payload = {"type": "personal_agent", "spaceId": CREDENTIALS["space_id"], "threadId": thread_id,
                       "createdSource": "full_page_chat", "clientMessageId": identifier(params["clientMessageId"]),
                       "content": [{"type": "text", "text": [[text]]}]}
            if model not in {"auto", "default"}:
                payload["model"] = model
            SENT.add(run_id)
            # Exactly one create attempt. No automatic model switch, no retry
            # after a timeout, and no thread deletion follows this call.
            response_ok(session.post(ORIGIN + "/api/v3/createAgentThread", json=payload, headers=headers,
                                     timeout=(15, 60), allow_redirects=False), "dispatch")
            notify("notion/started", {"runId": run_id, "threadId": thread_id})
        response = response_ok(session.post(ORIGIN + "/api/v3/listenToThreadTranscript",
            json={"spaceId": CREDENTIALS["space_id"], "threadId": thread_id, "includeProvisionalUserMessages": True, "includeQueueChanges": False},
            headers=CLIENT._agent_headers("application/x-ndjson"), stream=True, timeout=(15, 240), allow_redirects=False), "response")
        return read_reply(response, run_id, thread_id, require_anchor=recover)
    finally:
        if response is not None:
            response.close()
        session.close()


def handle(message):
    request_id = message.get("id")
    method, params = message.get("method"), message.get("params") or {}
    try:
        with CALL_LOCK:
            if method == "initialize":
                result = initialize(params)
            elif method == "chat/send":
                result = chat(params)
            elif method == "chat/recover":
                result = chat(params, True)
            elif method == "shutdown":
                STOP.set()
                result = {"closed": True}
            else:
                raise SafeError("invalid_response")
        write({"jsonrpc": "2.0", "id": request_id, "result": result})
    except Exception as failure:
        write({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32001, "message": "Notion request did not complete.", "data": public_failure(failure)}})


def main():
    for raw in sys.stdin:
        if len(raw) > 2 * 1024 * 1024:
            break
        try:
            message = json.loads(raw)
            if not isinstance(message, dict):
                continue
            if message.get("method") == "shutdown":
                STOP.set()
                write({"jsonrpc": "2.0", "id": message.get("id"), "result": {"closed": True}})
                return
            threading.Thread(target=handle, args=(message,), daemon=True).start()
        except (ValueError, TypeError):
            continue


if __name__ == "__main__":
    main()
