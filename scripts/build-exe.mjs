import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDirectory = path.join(projectDirectory, 'release');
const executablePath = path.join(releaseDirectory, 'Meedo-Hikvision-Sync-Agent.exe');
const blobPath = path.join(projectDirectory, 'build', 'meedo-agent.blob');
const postjectPath = path.join(projectDirectory, 'node_modules', 'postject', 'dist', 'cli.js');

await mkdir(releaseDirectory, { recursive: true });
await rm(executablePath, { force: true });
await copyFile(process.execPath, executablePath);

const result = spawnSync(process.execPath, [
  postjectPath,
  executablePath,
  'NODE_SEA_BLOB',
  blobPath,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
], { cwd: projectDirectory, stdio: 'inherit' });

if (result.status !== 0) {
  throw new Error(`postject failed with exit code ${result.status ?? 'unknown'}.`);
}

console.log(`Standalone executable created: ${executablePath}`);
