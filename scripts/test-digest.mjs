import {
  buildDigestAuthorization,
  parseDigestChallenge,
} from '../dist/src/hikvision.js';

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
console.log('RFC Digest vector passed; nonce count starts at 00000001.');
