"""Session leases preserve one web voice session; no upstream calls or credentials."""
import pytest
from fastapi.testclient import TestClient
from app import config, voice_service
from app.main import create_app
from app.session_registry import GatewayError, SessionRegistry


def test_24_hour_lease_keeps_identity_and_expiry_still_cleans_abandoned_sessions():
    now=[1000.0];released=[]
    registry=SessionRegistry(released.append,clock=lambda:now[0])
    owner={'id':'one','max_sessions':1}
    session=registry.reserve(owner,1800);sid=session['id'];registry.activate(sid,'one')
    for _ in range(4321):
        now[0]+=20
        updated=registry.renew(sid,'one')
        assert updated['id']==sid and updated['created_at']==1000.0
        assert updated['expires_at']==now[0]+1800
        assert len(registry.items)==1
    assert released==[]
    with pytest.raises(GatewayError):registry.renew(sid,'other')
    now[0]+=1801
    with pytest.raises(GatewayError):registry.renew(sid,'one')
    assert released==[sid]


def test_http_renew_uses_owner_auth_and_does_not_create_upstream_or_reveal_binding(tmp_path,monkeypatch):
    monkeypatch.setattr(config,'AUTH_KEY','test-admin')
    created=[];touched=[]
    monkeypatch.setattr(voice_service,'create_voice_session',lambda *args,**kwargs:created.append(kwargs) or {'answer_sdp':'v=0'})
    monkeypatch.setattr(voice_service,'_bound_voice_session',lambda sid:touched.append(sid) or {'access_token':'never-return-this'})
    app=create_app(tmp_path/'devices.sqlite3')
    now=[1000.0];app.state.sessions.clock=lambda:now[0]
    with TestClient(app) as client:
        def device(name):
            data=client.post('/v1/devices',headers={'Authorization':'Bearer test-admin'},json={'name':name}).json()
            return data,{'Authorization':'Bearer '+data['api_key']}
        a,ah=device('one');_,bh=device('other')
        assert client.get('/v1/capabilities',headers=ah).json()['session_renewal'] is True
        data=client.post('/v1/realtime/sessions',headers=ah,json={'offer_sdp':'v=0\r\ns=renew-test\r\nt=0 0\r\n'}).json()
        url='/v1/realtime/sessions/'+data['id']+'/renew';now[0]+=20
        assert client.post(url).status_code==401
        assert client.post(url,headers=bh).status_code==404
        result=client.post(url,headers=ah)
        assert result.status_code==200 and result.json()['expires_at']>data['expires_at']
        assert 'never-return-this' not in result.text and 'lease_seconds' not in result.text
        assert len(created)==1 and touched==[data['id']]
        assert client.delete('/v1/devices/'+a['id'],headers={'Authorization':'Bearer test-admin'}).status_code==204
        assert client.post(url,headers=ah).status_code==401
