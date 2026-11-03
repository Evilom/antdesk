import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { publicAddress, httpsUrl, signingKey, signedHeaders, safeWebhookFetch } from '../lib/webhook.mjs';

test('callback addresses exclude private, loopback, mapped and reserved ranges',()=>{
  for(const address of ['0.1.2.3','10.1.2.3','100.64.0.1','127.0.0.1','169.254.169.254','172.16.0.1','192.168.0.1','192.0.2.1','198.18.1.1','198.51.100.3','203.0.113.1','224.0.0.1','255.255.255.255','::1','::','::ffff:127.0.0.1','fc00::1','fe80::1','ff02::1','2001:db8::1','2002:7f00:1::1']) assert.equal(publicAddress(address),false,address);
  for(const address of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111','2001:4860:4860::8888'])assert.equal(publicAddress(address),true,address);
});

test('webhook URLs require HTTPS and cannot carry authority credentials',()=>{
  for(const value of ['http://example.com','https://name:secret@example.com','https://example.com/#secret','https://example.com:8443/'])assert.throws(()=>httpsUrl(value));
  assert.equal(httpsUrl('https://example.com/callback').hostname,'example.com');
});

test('production sender rejects literal private addresses before connecting',async()=>{
  await assert.rejects(safeWebhookFetch('https://127.0.0.1/'),e=>e.code==='private_callback');
  await assert.rejects(safeWebhookFetch('https://[::1]/'),e=>e.code==='private_callback');
});

test('Standard Webhooks signature covers exact serialized bytes and timestamp',()=>{
  const key=Buffer.alloc(32,0x42),secret='whsec_'+key.toString('base64'),body='{"text":"中文"}',id='evt-1';
  const headers=signedHeaders(secret,id,body,'sub-1',1730000000123);
  const expected=createHmac('sha256',key).update(id+'.1730000000.'+body).digest('base64');
  assert.equal(headers['webhook-signature'],'v1,'+expected);
  assert.equal(headers['X-MCP-Subscription-Id'],'sub-1');
  assert.equal(headers['webhook-timestamp'],'1730000000');
  assert.deepEqual(signingKey(secret),key);
  assert.throws(()=>signingKey('whsec_'+Buffer.alloc(16).toString('base64')));
  assert.throws(()=>signingKey('whsec_not-base64!'));
});
