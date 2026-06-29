import vm from 'node:vm';
import { CONFIG_WINDOW_HTML } from '../dist/src/window-content.js';

const match = CONFIG_WINDOW_HTML.match(/<script>([\s\S]*)<\/script>/);
if (!match) throw new Error('Configuration window script was not found.');
new vm.Script(match[1], { filename: 'configuration-window.js' });
console.log('Configuration window script syntax passed.');
