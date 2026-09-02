import { spawn } from 'node:child_process';

const children = [];
let stopping = false;

const start = (name, args) => {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  children.push(child);
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.log(`\n${name} se ha detenido${signal ? ` (${signal})` : ` con código ${code}`}.`);
    stop(code ?? 1);
  });
};

const stop = (exitCode = 0) => {
  if (stopping) return;
  stopping = true;
  children.forEach((child) => {
    if (!child.killed) child.kill('SIGTERM');
  });
  setTimeout(() => process.exit(exitCode), 250);
};

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

console.log('Arrancando Armario Virtual (backend + Expo)...\n');
start('Backend', ['--watch', 'server/index.mjs']);
start('Expo', ['node_modules/expo/bin/cli', 'start']);
