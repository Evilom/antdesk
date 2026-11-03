import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('../runtime/python/notion_worker.py', import.meta.url));
const python = process.env.ANTDESK_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const setup = String.raw`
import importlib.util, json, sys, types
spec = importlib.util.spec_from_file_location("worker", sys.argv[1])
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)
events = []
w.notify = lambda method, data: events.append((method, data))
class Response:
    def __init__(self, rows=(), status=200, payload=None, text=""):
        self.rows, self.status_code, self.payload, self.text = rows, status, payload, text
        self.closed = False
    def iter_lines(self):
        for row in self.rows:
            yield json.dumps(row).encode() if isinstance(row, dict) else row
    def json(self):
        return self.payload
    def close(self):
        self.closed = True
def delta(*entities):
    return {"type": "agent_service_transcript_delta", "patches": [{"op": "put", "entity": e} for e in entities]}
def message(text, kind="assistant_message", source="committed", id="answer"):
    return {"kind":kind,"source":source,"id":id,"content":[{"type":"text","text":text}]}
def fails(code, fn):
    try:
        fn()
    except w.SafeError as error:
        assert error.code == code, (error.code, code)
        return error
    raise AssertionError("expected " + code)
def group(user, spaces):
    return {"notion_user":{user:{"value":{"name":user}}}, "space":{s:{"value":{"name":s}} for s in spaces}}
`;

function runPython(body) {
  const result = spawnSync(python, ['-I', '-X', 'utf8', '-c', setup + '\n' + body, workerPath], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout || 'Notion worker unit case failed');
  assert.equal(result.stdout, '', 'Tests must not write account or stream content to stdout');
}

test('worker binds identities to server groups and fails closed for ambiguous accounts', () => runPython(String.raw`
data = {"first":group("user-a",["space-a"]),"second":group("user-b",["space-b","space-c"])}
rows = w.discover_accounts(data, {"notion_user_id":"user-b"})
assert [(r["user_id"],r["space_id"]) for r in rows] == [("user-b","space-b"),("user-b","space-c")]
fails("account_ambiguous", lambda:w.discover_accounts(data, {}))
fails("workspace_unavailable", lambda:w.discover_accounts({}, {}))
assert w.discover_accounts({"recordMap":group("user-a",["space-a"])},{})[0]["space_id"] == "space-a"
`));

test('worker rejects malformed credentials and never returns secret error material', () => runPython(String.raw`
assert w.cookie_values("token_v2=offline; notion_user_id=user-a")["notion_user_id"] == "user-a"
for header in ["", "token_v2=", "token_v2=private\r\nX:bad", "token_v2=private\\bad"]:
    fails("auth_required", lambda:w.cookie_values(header))
fails("account_ambiguous", lambda:w.cookie_values("token_v2=one; token_v2=two"))
fails("account_ambiguous", lambda:w.cookie_values("token_v2=one; notion_user_id=a; notion_user_id=b"))
kept = w.cookie_values("token_v2=offline; __cf_bm=one; __cf_bm=two")
assert kept["token_v2"] == "offline" and kept["__cf_bm"] == "one"
for status, code in [(401,"auth_required"),(402,"credits_exhausted"),(403,"access_denied"),(429,"rate_limited"),(503,"service_unavailable")]:
    error = fails(code, lambda:w.response_ok(Response(status=status,text="private token_v2=secret")))
    result = w.public_failure(error)
    assert result["code"] == code and result["httpStatus"] == status
    assert "secret" not in json.dumps(result)
fails("model_unavailable", lambda:w.response_ok(Response(status=400,text="does not support selected model")))
fails("credits_exhausted", lambda:w.response_ok(Response(status=400,text="insufficient_quota")))
`));

test('worker exposes only account-returned valid models and no hardcoded paid-model catalog', () => runPython(String.raw`
assert w.discover_models({}) == []
assert w.discover_models({"models":[{"id":"actual","displayName":"Available"},{"id":"denied","isAvailable":False},{"id":"bad id"}]}) == [{"id":"actual","name":"Available"}]
assert w.discover_models({"availableModels":{"model-one":{"label":"One","enabled":True}}}) == [{"id":"model-one","name":"One"}]
assert w.discover_models({"models":[{"id":"albuquerque-quinn"}]}) == [{"id":"albuquerque-quinn","name":"Opus 5.5"}]
`));

test('worker streams text, excludes hidden thinking and waits for an explicit completion event', () => runPython(String.raw`
rows = [delta({"kind":"thinking","content_text":"private chain of thought"},message("Hello",source="provisional")),
 {"type":"agent_service_transcript_delta","patches":[{"op":"patch","id":"answer","ops":[{"op":"append","path":"/content/0/text","value":" world"}]}]},
 delta(message("Hello world"),message("Hello world"),{"kind":"turn_completed"})]
result = w.read_reply(Response(rows),"run-one","thread-one")
assert result == {"completed":True,"text":"Hello world","threadId":"thread-one"}
assert events[-1][1]["text"] == "Hello world"
assert "private chain" not in json.dumps(events)
fails("incomplete_response",lambda:w.read_reply(Response([delta(message("partial committed answer"))]),"run-one","thread-one"))
fails("incomplete_response",lambda:w.read_reply(Response([delta({"kind":"turn_completed"})]),"run-one","thread-one"))
`));

test('worker recovery requires its request anchor and rejects another user turn', () => runPython(String.raw`
answer = delta(message("Our answer"),{"kind":"turn_completed"})
fails("ambiguous_response",lambda:w.read_reply(Response([answer]),"run-one","thread-one",True))
anchor = delta(message([["[AntDesk 事项 run-one]\nReview this"]],kind="user_message"))
assert w.read_reply(Response([anchor,answer]),"run-one","thread-one",True)["text"] == "Our answer"
foreign = delta(message("another conversation",kind="user_message"))
fails("ambiguous_response",lambda:w.read_reply(Response([anchor,foreign,answer]),"run-one","thread-one",True))
`));

test('worker reports approval and quota failures without auto-approving or exposing server payloads', () => runPython(String.raw`
for entity, code in [({"kind":"approval_request","message":"sensitive action"},"approval_required"),
                     ({"kind":"turn_failed","message":"quota_exceeded private token"},"credits_exhausted"),
                     ({"kind":"turn_failed","message":"rate_limit private token"},"rate_limited"),
                     ({"kind":"turn_failed","message":"login_required private token"},"auth_required")]:
    error=fails(code,lambda:w.read_reply(Response([delta(entity)]),"run-one","thread-one"))
    assert "private" not in json.dumps(w.public_failure(error))
assert events == []
`));

test('worker sends once, omits an Auto override and recovers by reading the same thread', () => runPython(String.raw`
requests=[]
class Session:
    def post(self,url,**kw):
        requests.append((url,kw))
        if url.endswith("createAgentThread"):
            return Response()
        return Response([delta(message("[AntDesk 事项 run-one]",kind="user_message")),delta(message("done"),{"kind":"turn_completed"})])
    def close(self): pass
w.MODULE=types.SimpleNamespace(_new_http_session=Session)
w.CLIENT=types.SimpleNamespace(_agent_headers=lambda *args:{"Cookie":"offline-only"})
w.ACCOUNT={"id":"user-a"};w.CREDENTIALS={"space_id":"space-a"};w.MODELS=[]
params={"runId":"run-one","threadId":"thread-one","clientMessageId":"message-one","accountId":"user-a","workspaceId":"space-a","model":"auto","text":"[AntDesk 事项 run-one]"}
assert w.chat(params)["text"] == "done"
assert "model" not in requests[0][1]["json"]
assert requests[0][1]["json"]["threadId"] == "thread-one"
fails("already_sent",lambda:w.chat(params))
assert w.chat(params,True)["text"] == "done"
assert sum(url.endswith("createAgentThread") for url,_ in requests) == 1
assert sum(url.endswith("listenToThreadTranscript") for url,_ in requests) == 2
assert all(kw["allow_redirects"] is False for _,kw in requests)
`));

test('worker records attempted delivery before timeout and does not automatically retry', () => runPython(String.raw`
requests=[]
class Session:
    def post(self,url,**kw):
        requests.append(url)
        raise TimeoutError("private credential")
    def close(self): pass
w.MODULE=types.SimpleNamespace(_new_http_session=Session)
w.CLIENT=types.SimpleNamespace(_agent_headers=lambda *args:{})
w.ACCOUNT={"id":"user-a"};w.CREDENTIALS={"space_id":"space-a"};w.MODELS=[]
params={"runId":"run-one","threadId":"thread-one","clientMessageId":"message-one","accountId":"user-a","workspaceId":"space-a","model":"auto","text":"review"}
try: w.chat(params)
except TimeoutError as error: assert w.public_failure(error)["code"] == "network_timeout"
else: raise AssertionError("expected timeout")
fails("already_sent",lambda:w.chat(params))
assert len(requests) == 1
`));

test('worker initialization only discovers identity/models and never sends AI test prompts', () => runPython(String.raw`
requests=[]
class Session:
    def post(self,url,**kw):
        requests.append(url)
        if url.endswith("getSpaces"): return Response(payload={"user-a":group("user-a",["space-a"])})
        if url.endswith("getAvailableModels"): return Response(payload={"models":[{"id":"account-model"}]})
        raise AssertionError("unexpected endpoint")
    def close(self): pass
w.load_upstream=lambda source:types.SimpleNamespace(_new_http_session=Session,BROWSER_UA="offline",NotionOpusAPI=lambda config:object())
result=w.initialize({"source":"unused","cookies":"token_v2=offline; notion_user_id=user-a","workspaceId":"space-a"})
assert result["workspaceId"] == "space-a" and result["modelsSource"] == "account"
assert result["account"] == {"id":"user-a","name":"user-a"}
assert [url.rsplit("/",1)[-1] for url in requests] == ["getSpaces","getAvailableModels"]
assert "offline" not in json.dumps(result)
`));

test('worker allows one metadata-shape fallback but never retries an authentication challenge', () => runPython(String.raw`
requests=[]
class Session:
    denied=False
    def post(self,url,**kw):
        requests.append(url.rsplit("/",1)[-1])
        if url.endswith("getSpaces"): return Response(status=403 if Session.denied else 200,payload={})
        if url.endswith("loadUserContent"): return Response(payload={"recordMap":group("user-a",["space-a","space-b"])})
        raise AssertionError("unexpected endpoint")
    def close(self): pass
w.load_upstream=lambda source:types.SimpleNamespace(_new_http_session=Session,BROWSER_UA="offline",NotionOpusAPI=lambda config:object())
params={"source":"unused","cookies":"token_v2=offline","workspaceId":""}
result=w.initialize(params)
assert result["workspaceId"] == "" and len(result["workspaces"]) == 2
assert requests == ["getSpaces","loadUserContent"]
Session.denied=True;requests.clear()
fails("access_denied",lambda:w.initialize(params))
assert requests == ["getSpaces"]
`));
