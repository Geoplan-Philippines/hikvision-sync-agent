import { writeLog } from '../dist/src/logger.js';

let output = '';
const original = console.log;
console.log = (value) => { output = String(value); };
writeLog('info', 'EVENTS FOUND', { raw: 57, registered: 9, pending: 1 });
console.log = original;

if (!/\[INFO] Attendance events scanned — Raw: 57; Registered: 9; Pending: 1$/.test(output)) {
  throw new Error(`Readable logger output was invalid: ${output}`);
}
console.log('Readable logger format passed.');
