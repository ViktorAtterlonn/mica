import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { MongoClient } from 'mongodb';

export const uri = process.env.MICA_STRESS_URI;
assert(uri && process.env.MICA_STRESS_MEMBERS, 'Use the disposable stress runner');
export const members = JSON.parse(process.env.MICA_STRESS_MEMBERS);
export const report = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  driver: JSON.parse(readFileSync('node_modules/mongodb/package.json', 'utf8')).version,
  passed: false,
  scenarios: [],
};
export function save() {
  writeFileSync('report.json', JSON.stringify(report, null, 2));
}
export async function until(check, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(100);
  }
  throw new Error(message, { cause: last });
}
export async function fault(action, member) {
  assert(members.includes(member));
  const id = `${Date.now()}-${action}`;
  writeFileSync('control/request.tmp', JSON.stringify({ action, member, id }));
  renameSync('control/request.tmp', 'control/request.json');
  await until(
    () => {
      if (!existsSync('control/response.json')) return false;
      const response = JSON.parse(readFileSync('control/response.json', 'utf8'));
      if (response.id !== id) return false;
      rmSync('control/response.json');
      return response.ok;
    },
    `Host did not complete ${action}`,
    30_000,
  );
}
export function poolMetrics(client) {
  const connections = new Set();
  let checkedOut = 0;
  let peakCheckedOut = 0;
  client.on('connectionCreated', (e) => connections.add(`${e.address}/${e.connectionId}`));
  client.on('connectionClosed', (e) => connections.delete(`${e.address}/${e.connectionId}`));
  client.on('connectionCheckedOut', () => {
    checkedOut++;
    peakCheckedOut = Math.max(peakCheckedOut, checkedOut);
  });
  client.on('connectionCheckedIn', () => {
    checkedOut--;
  });
  return () => ({ open: connections.size, checkedOut, peakCheckedOut });
}
export function client(options = {}) {
  return new MongoClient(uri, {
    appName: 'mica-stress',
    maxPoolSize: 12,
    serverSelectionTimeoutMS: 8000,
    heartbeatFrequencyMS: 500,
    writeConcern: { w: 'majority', wtimeoutMS: 5000 },
    ...options,
  });
}
export async function direct(member) {
  const connection = new MongoClient(`mongodb://${member}:27017/?directConnection=true`, {
    serverSelectionTimeoutMS: 3000,
  });
  await connection.connect();
  return connection;
}
export async function scenario(name, work) {
  console.log(`Starting: ${name}`);
  const start = performance.now();
  try {
    const details = await work();
    report.scenarios.push({
      name,
      passed: true,
      elapsedMs: Math.round(performance.now() - start),
      ...details,
    });
    console.log(`Passed: ${name}`);
  } catch (error) {
    report.scenarios.push({ name, passed: false, error: error.stack });
    throw error;
  } finally {
    save();
  }
}
