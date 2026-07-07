import {
  HikvisionClient,
  buildDigestAuthorization,
  parseDigestChallenge,
} from '../dist/src/hikvision.js';
import {
  isHikvisionAuthenticationHalted,
  resetHikvisionAuthentication,
} from '../dist/src/hikvision-auth.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const challenge = parseDigestChallenge(
  'Digest realm="testrealm@host.com", qop="auth,auth-int", ' +
  'nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", ' +
  'opaque="5ccc069c403ebaf9f0171e9517f40e41"',
);
const authorization = buildDigestAuthorization({
  username: 'Mufasa',
  password: 'Circle Of Life',
  method: 'GET',
  uri: '/dir/index.html',
  challenge,
  nonceCount: 1,
  cnonce: '0a4f113b',
});

if (!authorization.includes('response="6629fae49393a05397450978507c4ef1"')) {
  throw new Error('Digest response did not match the RFC test vector.');
}
if (!authorization.includes('nc=00000001')) {
  throw new Error('Digest nonce count did not start at 00000001.');
}

process.env.HIKVISION_HOST = 'device.test';
process.env.HIKVISION_USER = 'admin';
process.env.HIKVISION_PASS = 'secret';
const challengeHeaders = { 'www-authenticate': 'Digest realm=test, nonce=n1, qop=auth' };
const originalFetch = globalThis.fetch;

// The sync client recovers from a stale-nonce 401 by re-handshaking, without halting.
resetHikvisionAuthentication();
let recoverCalls = 0;
globalThis.fetch = async (_url, init) => {
  recoverCalls += 1;
  const auth = new Headers(init?.headers).get('authorization');
  // 1: challenge, 2: authenticated → stale 401, 3: challenge, 4: authenticated → 200.
  if (recoverCalls === 2) return new Response(null, { status: 401 });
  if (!auth) return new Response(null, { status: 401, headers: challengeHeaders });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};
const recovered = await new HikvisionClient().request('/ISAPI/test');
assert(recovered && recovered.ok === true, 'Sync client did not recover from a transient 401.');
assert(!isHikvisionAuthenticationHalted(), 'Sync client wrongly halted on a transient 401.');
assert(recoverCalls === 4, `Sync client did not re-handshake exactly once (fetches=${recoverCalls}).`);

// Persistent authenticated 401s still halt after the bounded retries.
resetHikvisionAuthentication();
let haltCalls = 0;
globalThis.fetch = async (_url, init) => {
  haltCalls += 1;
  const auth = new Headers(init?.headers).get('authorization');
  return auth
    ? new Response(null, { status: 401 })
    : new Response(null, { status: 401, headers: challengeHeaders });
};
const rejected = await new HikvisionClient().request('/ISAPI/test');
assert(rejected === null, 'Rejected sync request should return null.');
assert(isHikvisionAuthenticationHalted(), 'Persistent 401 did not halt after bounded retries.');
assert(haltCalls === 6, `Sync client did not retry twice before halting (fetches=${haltCalls}).`);
resetHikvisionAuthentication();
globalThis.fetch = originalFetch;

console.log('RFC Digest vector passed; nonce count starts at 00000001; sync-client 401 recovery passed.');
