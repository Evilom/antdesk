import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import { createHmac } from 'node:crypto';
import { BridgeError, fail, string } from './util.mjs';

export function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a===0 || a===10 || a===127 || a>=224 || (a===100 && b>=64 && b<=127) || (a===169 && b===254) ||
      (a===172 && b>=16 && b<=31) || (a===192 && (b===168 || b===0 || (b===88 && c===99))) ||
      (a===198 && (b===18 || b===19 || (b===51 && c===100))) || (a===203 && b===0 && c===113));
  }
  if (net.isIP(address) === 6) {
    // Only global-unicast space; this also excludes IPv4-mapped/local/multicast addresses.
    const first = parseInt(address.split(':')[0],16);
    return first >= 0x2000 && first <= 0x3fff && first!==0x2002 && !/^2001:0?db8:/i.test(address) && !/^2001:(?:0*:|0?10:|0?20:)/i.test(address);
  }
  return false;
}
export function httpsUrl(value) {
  string(value,'HTTPS URL',2048);
  let url; try { url = new URL(value); } catch { fail(400,'invalid_url','A valid HTTPS URL is required.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) fail(400,'invalid_url','An HTTPS URL on port 443 without credentials or fragments is required.');
  return url;
}
export async function safeWebhookFetch(value, options = {}) {
  const url = httpsUrl(String(value)); const hostname = url.hostname.replace(/^\[|\]$/g,'');
  let addresses, lookupTimer;
  try { addresses = net.isIP(hostname) ? [{address:hostname,family:net.isIP(hostname)}] : await Promise.race([
    dns.lookup(hostname,{all:true,verbatim:true}),
    new Promise((_,reject)=>{lookupTimer=setTimeout(()=>reject(new Error('DNS timeout')),5000);}),
  ]); }
  catch { throw new BridgeError(502,'delivery_network','Unable to resolve the webhook destination.'); }
  finally {clearTimeout(lookupTimer);}
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) fail(400,'private_callback','Webhook destinations must resolve only to public addresses.');
  const selected = addresses[0];
  return new Promise((resolve,reject) => {
    let settled = false;
    const finish = (error,response) => { if (settled) return; settled=true; clearTimeout(timer); if(error) reject(error); else resolve(response); };
    const request = https.request(url, {
      method:options.method || 'POST', headers:options.headers, agent:false,
      lookup:(_name,opts,callback) => opts?.all ? callback(null,[selected]) : callback(null,selected.address,selected.family),
      servername:net.isIP(hostname) ? undefined : hostname,
    }, response => {
      const chunks=[]; let length=0;
      response.on('data', chunk => { length+=chunk.length; if(length>262144) request.destroy(new Error('oversize')); else chunks.push(chunk); });
      response.on('end', () => {
        try { const status=response.statusCode||502;if(status<200||status>599)throw new Error('Invalid HTTP status');const body=[204,205,304].includes(status)?null:Buffer.concat(chunks);finish(null,new Response(body,{status,headers:response.headers})); }
        catch {finish(new BridgeError(502,'delivery_network','The webhook response was invalid.'));}
      });
      response.on('error', () => finish(new BridgeError(502,'delivery_network','The webhook response could not be read.')));
    });
    const timer=setTimeout(() => request.destroy(new Error('timeout')),10000);
    request.on('error', () => finish(new BridgeError(502,'delivery_network','The webhook delivery could not be confirmed.')));
    request.end(options.body || '');
  });
}
export function signingKey(secret) {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) fail(400,'invalid_secret','A Standard Webhooks signing secret is required.');
  const encoded=secret.slice(6), decoded=Buffer.from(encoded,'base64');
  if(decoded.length<24 || decoded.length>64 || decoded.toString('base64').replace(/=+$/,'')!==encoded.replace(/=+$/,'')) fail(400,'invalid_secret','The signing key must contain 24–64 bytes.');
  return decoded;
}
export function signedHeaders(secret,id,body,subscriptionId,at=Date.now()) {
  const timestamp=String(Math.floor(at/1000));
  const signature=createHmac('sha256',signingKey(secret)).update(id+'.'+timestamp+'.'+body).digest('base64');
  return {'Content-Type':'application/json','webhook-id':id,'webhook-timestamp':timestamp,'webhook-signature':'v1,'+signature,'X-MCP-Subscription-Id':subscriptionId};
}
