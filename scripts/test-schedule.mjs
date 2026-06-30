import {
  dailySyncWindow,
  eventWindowStart,
  formatManilaTime,
  syncAllowedAt,
} from '../dist/src/sync.js';

process.env.SYNC_START_TIME = '09:00';
process.env.SYNC_END_TIME = '17:07';
const daily = dailySyncWindow(new Date('2026-06-29T01:00:00Z'));
const morning = eventWindowStart('2026-06-28T08:00:00Z', daily);
const interval = eventWindowStart('2026-06-29T01:05:00Z', daily);
const realtime = eventWindowStart(
  '2026-06-29T01:05:00Z',
  daily,
  'biometric_trigger',
  new Date('2026-06-29T01:05:20Z'),
);
const realtimeBeforeSchedule = eventWindowStart(
  '2026-06-29T01:01:00Z',
  daily,
  'biometric_trigger',
  new Date('2026-06-29T01:02:00Z'),
);
const coldRealtime = eventWindowStart(
  null,
  daily,
  'watchdog',
  new Date('2026-06-29T01:02:00Z'),
);

if (formatManilaTime(morning.start) !== '2026-06-28T17:07:00+08:00') {
  throw new Error('Morning catch-up did not start at the previous daily end.');
}
if (morning.mode !== 'morning_catch_up') throw new Error('Morning mode was not selected.');
if (formatManilaTime(interval.start) !== '2026-06-29T09:00:00+08:00') {
  throw new Error('Interval re-scan did not start at today\'s daily start.');
}
if (interval.mode !== 'interval_rescan') throw new Error('Interval mode was not selected.');
if (formatManilaTime(realtime.start) !== '2026-06-29T09:04:50+08:00') {
  throw new Error('Real-time sync did not resume from its cursor with overlap.');
}
if (realtime.mode !== 'realtime_cursor') throw new Error('Real-time mode was not selected.');
if (formatManilaTime(realtimeBeforeSchedule.start) !== '2026-06-29T09:00:50+08:00') {
  throw new Error('Real-time lookback stopped at the scheduled daily start.');
}
if (formatManilaTime(coldRealtime.start) !== '2026-06-29T08:57:00+08:00') {
  throw new Error('Cold real-time watchdog did not use its bounded lookback.');
}
const beforeSchedule = new Date('2026-06-29T00:30:00Z');
if (!syncAllowedAt('biometric_trigger', beforeSchedule, daily)) {
  throw new Error('Biometric trigger was blocked before the scheduled daily start.');
}
if (!syncAllowedAt('watchdog', beforeSchedule, daily)) {
  throw new Error('Real-time watchdog was blocked before the scheduled daily start.');
}
if (syncAllowedAt('scheduled', beforeSchedule, daily)) {
  throw new Error('Scheduled polling ran before the daily start.');
}
console.log('Daily schedule tests passed.');
