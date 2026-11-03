"""Chrome-fingerprint HTTP for the ChatGPT Dots API.

Node's own TLS is challenged on /backend-api/tbo even with a valid account
token. curl_cffi's Chrome impersonation is the client that reaches the same
account's Dot catalog. This process never reads auth files, cookies, or the
environment. The caller supplies one already-authorized request at a time.
"""
from __future__ import annotations

import json
import sys
import threading
from urllib.parse import urlsplit

WRITE_LOCK = threading.Lock()
REQUEST_LOCK = threading.Lock()
MAX_LINE = 2 * 1024 * 1024
MAX_BODY = 8 * 1024 * 1024
ALLOWED_HEADERS = {
    "authorization": "Authorization",
    "chatgpt-account-id": "ChatGPT-Account-ID",
    "accept": "Accept",
    "oai-language": "OAI-Language",
    "originator": "originator",
    "oai-product-sku": "OAI-Product-Sku",
    "content-type": "Content-Type",
}
PUBLIC_RESPONSE_HEADERS = ("content-type", "cf-mitigated", "retry-after")


class Rejected(ValueError):
    pass


def output(value: dict) -> None:
    with WRITE_LOCK:
        sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def allowed_url(value: str) -> str:
    if not isinstance(value, str) or len(value) > 4096 or any(char in value for char in "\r\n\0"):
        raise Rejected("invalid url")
    parts = urlsplit(value)
    if parts.scheme != "https" or parts.hostname != "chatgpt.com" or parts.port not in (None, 443):
        raise Rejected("invalid url")
    if parts.username or parts.password or parts.fragment or not parts.path.startswith("/backend-api/"):
        raise Rejected("invalid url")
    if "\\" in parts.path or parts.path.startswith("//"):
        raise Rejected("invalid url")
    return value


def allowed_headers(value) -> dict:
    if not isinstance(value, dict) or len(value) > len(ALLOWED_HEADERS):
        raise Rejected("invalid headers")
    headers = {}
    for name, item in value.items():
        canonical = ALLOWED_HEADERS.get(name.lower() if isinstance(name, str) else "")
        if not canonical or not isinstance(item, str) or len(item) > 16384 or any(char in item for char in "\r\n\0"):
            raise Rejected("invalid headers")
        headers[canonical] = item
    if "Authorization" not in headers or "ChatGPT-Account-ID" not in headers:
        raise Rejected("invalid headers")
    return headers


def perform(params: dict) -> dict:
    if not isinstance(params, dict):
        raise Rejected("invalid request")
    method = params.get("method") or "GET"
    if method not in {"GET", "POST"}:
        raise Rejected("invalid method")
    url = allowed_url(params.get("url"))
    headers = allowed_headers(params.get("headers"))
    body = params.get("body")
    if body is None:
        payload = None
    elif method == "POST" and isinstance(body, str) and len(body.encode("utf-8")) <= 1_500_000:
        payload = body.encode("utf-8")
    else:
        raise Rejected("invalid body")
    timeout = params.get("timeoutSeconds", 30)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 1 <= timeout <= 60:
        raise Rejected("invalid timeout")
    from curl_cffi import requests as client

    with REQUEST_LOCK:
        response = client.request(
            method, url, headers=headers, data=payload, impersonate="chrome",
            timeout=timeout, allow_redirects=False, verify=True,
        )
    if len(response.content) > MAX_BODY:
        raise Rejected("response too large")
    visible = {}
    for name in PUBLIC_RESPONSE_HEADERS:
        item = response.headers.get(name)
        if isinstance(item, str) and item and len(item) <= 200 and not any(char in item for char in "\r\n\0"):
            visible[name] = item
    return {"status": int(response.status_code), "headers": visible, "body": response.text}


def handle(message: dict) -> None:
    request_id = message.get("id")
    try:
        if message.get("method") != "fetch":
            raise Rejected("unsupported method")
        result = perform(message.get("params") or {})
        output({"jsonrpc": "2.0", "id": request_id, "result": result})
    except Rejected:
        output({"jsonrpc": "2.0", "id": request_id, "error": {
            "code": -32602, "message": "Dots request was rejected.", "data": {"code": "invalid_endpoint"}}})
    except Exception:
        # curl errors can echo the request URL. Never return that text.
        output({"jsonrpc": "2.0", "id": request_id, "error": {
            "code": -32000, "message": "Dots browser request did not complete.", "data": {"code": "dots_network"}}})


def main() -> None:
    for line in sys.stdin:
        if len(line) > MAX_LINE:
            break
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if isinstance(message, dict) and isinstance(message.get("method"), str):
            handle(message)


if __name__ == "__main__":
    main()
