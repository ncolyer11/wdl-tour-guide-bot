import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SecureStore } from '../src/secure-store';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));

test('round trips and never leaves plaintext on disk', () => {
  const dir = tmp();
  const s = new SecureStore(dir);
  s.save('db', { users: [{ userId: '123456' }] });
  assert.deepEqual(s.load('db'), { users: [{ userId: '123456' }] });
  assert.equal(fs.readFileSync(path.join(dir, 'db.enc'), 'utf8').includes('123456'), false);
  assert.equal(fs.readdirSync(dir).some(f => f.endsWith('.tmp')), false);
});

test('missing file loads as undefined', () => {
  assert.equal(new SecureStore(tmp()).load('nope'), undefined);
});

test('tampering is detected', () => {
  const dir = tmp();
  const s = new SecureStore(dir);
  s.save('db', { a: 1 });
  const file = path.join(dir, 'db.enc');
  const env = JSON.parse(fs.readFileSync(file, 'utf8'));
  env.ct = Buffer.from('tampered').toString('base64');
  fs.writeFileSync(file, JSON.stringify(env));
  assert.throws(() => s.load('db'));
});

test('wrong key is detected', () => {
  const dir = tmp();
  new SecureStore(dir).save('db', { a: 1 });
  fs.writeFileSync(path.join(dir, 'db.key'), 'ab'.repeat(32));
  assert.throws(() => new SecureStore(dir).load('db'));
});

test('key file is private', () => {
  const dir = tmp();
  new SecureStore(dir);
  assert.equal(fs.statSync(path.join(dir, 'db.key')).mode & 0o777, 0o600);
});
