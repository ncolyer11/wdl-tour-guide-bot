import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Encrypted, crash-safe JSON storage.
 *
 *  - AES-256-GCM (authenticated: tampering or a wrong key is detected, never silently accepted)
 *  - fresh random 96-bit IV for every write
 *  - atomic writes (temp file + fsync + rename) so a power cut can't leave a half-written file
 *  - key comes from the BOT_DB_KEY env var, or from <dataDir>/db.key (created on first run, mode 0600)
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AAD = Buffer.from('wdl-bot:v1');

interface Envelope {
  v: 1;
  alg: typeof ALGORITHM;
  iv: string;
  tag: string;
  ct: string;
}

export class SecureStore {
  private readonly key: Buffer;

  constructor(private readonly dir: string, keyEnvVar = 'BOT_DB_KEY') {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.key = SecureStore.resolveKey(dir, keyEnvVar);
  }

  /** Encrypts `value` as JSON and atomically writes it to <dir>/<name>.enc */
  save(name: string, value: unknown): void {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(AAD);
    const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const envelope: Envelope = {
      v: 1,
      alg: ALGORITHM,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ct.toString('base64'),
    };
    atomicWrite(this.file(name), JSON.stringify(envelope));
  }

  /**
   * Returns the decrypted value, or undefined if the file doesn't exist.
   * Throws if the file exists but can't be decrypted (wrong key, corruption, tampering).
   */
  load<T = unknown>(name: string): T | undefined {
    const file = this.file(name);
    if (!fs.existsSync(file)) return undefined;

    const envelope = JSON.parse(fs.readFileSync(file, 'utf8')) as Envelope;
    if (envelope.v !== 1 || envelope.alg !== ALGORITHM) {
      throw new Error(`Unsupported envelope format in ${name}.enc`);
    }
    const decipher = crypto.createDecipheriv(ALGORITHM, this.key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as T;
  }

  /** Moves an unreadable file aside so a fresh save can't overwrite data that might still be recoverable. */
  quarantine(name: string): void {
    const file = this.file(name);
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.unreadable-${Date.now()}`);
  }

  private file(name: string): string {
    return path.join(this.dir, `${name}.enc`);
  }

  private static resolveKey(dir: string, keyEnvVar: string): Buffer {
    const fromEnv = process.env[keyEnvVar];
    if (fromEnv) return SecureStore.parseKey(fromEnv, keyEnvVar);

    const keyPath = path.join(dir, 'db.key');
    if (fs.existsSync(keyPath)) return SecureStore.parseKey(fs.readFileSync(keyPath, 'utf8'), keyPath);

    const key = crypto.randomBytes(KEY_BYTES);
    fs.writeFileSync(keyPath, key.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    console.warn(
      `[secure-store] Generated a new encryption key at ${keyPath}.\n` +
      '  Back it up somewhere SEPARATE from the data files. If it is lost, the encrypted data cannot be recovered.'
    );
    return key;
  }

  private static parseKey(raw: string, source: string): Buffer {
    const text = raw.trim();
    const key = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(`Encryption key from ${source} must be 32 bytes (64 hex chars or base64).`);
    }
    return key;
  }
}

function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd); // force it to disk before the rename makes it "the" file
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}
