import {
  HikvisionAlertStream,
  IncrementalAlertParser,
  isRelevantAccessEvent,
} from '../dist/src/alert-stream.js';
import { SingleFlightSyncCoordinator } from '../dist/src/sync-coordinator.js';
import { parseBatchIngestResponse } from '../dist/src/sync.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const batchResponse = parseBatchIngestResponse({ data: {
  ingested: 1,
  duplicates: 1,
  unknown: 1,
  results: [
    { externalId: 'one', status: 'ingested' },
    { externalId: 'two', status: 'duplicate' },
    { externalId: 'three', status: 'unknown_biometrics_id' },
  ],
} });
assert(batchResponse.results.length === 3, 'Wrapped VPS batch response was not parsed.');

const accessJson = JSON.stringify({
  EventNotificationAlert: {
    eventType: 'AccessControllerEvent',
    AccessControllerEvent: { employeeNoString: '42' },
  },
});
const heartbeatJson = JSON.stringify({ EventNotificationAlert: { eventType: 'heartbeat' } });
const unrelatedJson = JSON.stringify({
  EventNotificationAlert: { eventType: 'diskFull', majorEventType: 3 },
});
const firmwareVariantJson = JSON.stringify({
  EventNotificationAlert: {
    eventType: 'AccessControllerEvent',
    majorEventType: 3,
    AccessControllerEvent: { employeeNoString: '42' },
  },
});
const accessXml = '<EventNotificationAlert><eventType>AccessControllerEvent</eventType>' +
  '<AccessControllerEvent><employeeNoString>42</employeeNoString></AccessControllerEvent>' +
  '</EventNotificationAlert>';

const jsonParser = new IncrementalAlertParser('application/json');
let jsonMessages = [];
for (const character of accessJson) jsonMessages.push(...jsonParser.push(character));
assert(jsonMessages.length === 1, 'Split JSON did not produce exactly one message.');
assert(isRelevantAccessEvent(jsonMessages[0]), 'Access-control JSON was not relevant.');

const xmlParser = new IncrementalAlertParser('application/xml');
let xmlMessages = [];
for (const character of accessXml) xmlMessages.push(...xmlParser.push(character));
assert(xmlMessages.length === 1, 'Split XML did not produce exactly one message.');
assert(isRelevantAccessEvent(xmlMessages[0]), 'Access-control XML was not relevant.');

const multipart = '--alerts\r\nContent-Type: application/json\r\n\r\n' + accessJson +
  '\r\n--alerts\r\nContent-Type: application/xml\r\n\r\n' + accessXml +
  '\r\n--alerts--\r\n';
const multipartParser = new IncrementalAlertParser('multipart/mixed; boundary=alerts');
let multipartMessages = [];
for (const character of multipart) multipartMessages.push(...multipartParser.push(character));
assert(multipartMessages.length === 2, 'Split multipart data did not produce two messages.');

const heartbeat = new IncrementalAlertParser().push(heartbeatJson)[0];
const unrelated = new IncrementalAlertParser().push(unrelatedJson)[0];
const firmwareVariant = new IncrementalAlertParser().push(firmwareVariantJson)[0];
assert(!isRelevantAccessEvent(heartbeat), 'Heartbeat incorrectly triggered a sync.');
assert(!isRelevantAccessEvent(unrelated), 'Unrelated alarm incorrectly triggered a sync.');
assert(
  isRelevantAccessEvent(firmwareVariant),
  'Firmware access event with unexpected major code did not trigger a sync.',
);

let releaseFirst;
const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
const calls = [];
const coordinator = new SingleFlightSyncCoordinator(async (reason) => {
  calls.push(reason);
  if (calls.length === 1) await firstGate;
});
const drain = coordinator.request('scheduled');
await new Promise((resolve) => setTimeout(resolve, 0));
coordinator.request('biometric_trigger');
coordinator.request('biometric_trigger');
coordinator.request('scheduled');
releaseFirst();
await drain;
assert(calls.length === 2, 'Burst requests were not coalesced into one follow-up cycle.');
assert(calls[1] === 'biometric_trigger', 'The queued biometric reason was lost.');

let triggerCount = 0;
let streamController;
let streamFetches = 0;
const streamFetch = async (_url, init) => {
  streamFetches += 1;
  if (streamFetches === 1) {
    return new Response(null, {
      status: 401,
      headers: { 'www-authenticate': 'Digest realm=test, nonce=abc, qop=auth' },
    });
  }
  assert(new Headers(init.headers).has('authorization'), 'Authenticated stream request was missing Digest.');
  return new Response(new ReadableStream({
    start(controller) {
      streamController = controller;
      controller.enqueue(new TextEncoder().encode(accessJson + accessJson));
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const stream = new HikvisionAlertStream({
  host: 'device.test', username: 'admin', password: 'secret', fetchImpl: streamFetch,
  debounceMs: 5,
  onTrigger: () => { triggerCount += 1; },
});
stream.start();
await new Promise((resolve) => setTimeout(resolve, 20));
assert(triggerCount === 1, 'Rapid stream events did not debounce to one trigger.');
stream.stop();
streamController.close();
stream.dispose();

let failedFetches = 0;
const reconnectAttempts = [];
const reconnecting = new HikvisionAlertStream({
  host: 'device.test', username: 'admin', password: 'secret',
  fetchImpl: async () => {
    failedFetches += 1;
    throw new Error('network unavailable');
  },
  reconnectDelaysMs: [1, 2, 5], random: () => 0.5,
  onTrigger: () => undefined,
  onStatusChange: (value) => {
    if (value.reconnectAttempt) reconnectAttempts.push(value.reconnectAttempt);
  },
});
reconnecting.start();
await new Promise((resolve) => setTimeout(resolve, 25));
reconnecting.dispose();
assert(failedFetches >= 3, 'Network failures did not reconnect.');
assert(reconnectAttempts.includes(1) && reconnectAttempts.includes(2), 'Reconnect backoff did not advance.');

let unsupportedFetches = 0;
const unsupported = new HikvisionAlertStream({
  host: 'device.test', username: 'admin', password: 'secret',
  fetchImpl: async () => { unsupportedFetches += 1; return new Response(null, { status: 404 }); },
  onTrigger: () => undefined,
});
unsupported.start();
await new Promise((resolve) => setTimeout(resolve, 5));
unsupported.start();
await new Promise((resolve) => setTimeout(resolve, 5));
assert(unsupportedFetches === 1, 'Unsupported stream response was retried.');
assert(unsupported.currentStatus.listenerState === 'stopped', 'Unsupported stream was not stopped.');
unsupported.dispose();

let rejectedAuthFetches = 0;
const authRejected = new HikvisionAlertStream({
  host: 'device.test', username: 'admin', password: 'wrong',
  fetchImpl: async () => {
    rejectedAuthFetches += 1;
    return rejectedAuthFetches === 1
      ? new Response(null, {
          status: 401,
          headers: { 'www-authenticate': 'Digest realm=test, nonce=def, qop=auth' },
        })
      : new Response(null, { status: 401 });
  },
  onTrigger: () => undefined,
});
authRejected.start();
await new Promise((resolve) => setTimeout(resolve, 10));
authRejected.start();
await new Promise((resolve) => setTimeout(resolve, 5));
assert(rejectedAuthFetches === 2, 'Authenticated 401 retried credentials.');
assert(
  authRejected.currentStatus.listenerState === 'authentication_halted',
  'Authenticated 401 did not halt authentication.',
);
authRejected.dispose();

console.log('Real-time parser, filtering, debounce, reconnect, auth, and single-flight tests passed.');
