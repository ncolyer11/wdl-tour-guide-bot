import * as fs from 'fs';
import * as path from 'path';
import { SecureStore } from './secure-store';
import { errMsg } from './utils';

const DATA_DIR = path.join(__dirname, '..', 'data');
const LEGACY_DB_PATH = path.join(__dirname, 'database.json');
const LEGACY_BACKUP_PATH = path.join(__dirname, 'database_backup.json');

/** The only per-user data that is ever persisted (encrypted). No names, roles or message content. */
export interface StoredUser {
  userId: string;
  firstSeen: number;
  totalMessageCount: number;
}

export interface CooldownMetrics {
  botMessageCount: number;
  botLimitReached: boolean;
  currentHour: number; // hours since the epoch
  lastPaperMsgTimestamp: number;
  lastMessageIndex: number | undefined;
  lastBackupAt: number;
}

interface PersistedData {
  schemaVersion: 2;
  cdMetrics: CooldownMetrics;
  latestStemlightReleaseTag: string;
  users: StoredUser[];
  optedOut: string[];
}

interface LoadResult { data: unknown; legacy: boolean }

export const currentEpochHour = (): number => Math.floor(Date.now() / 3_600_000);

function defaultMetrics(): CooldownMetrics {
  return {
    botMessageCount: 0,
    botLimitReached: false,
    currentHour: currentEpochHour(),
    lastPaperMsgTimestamp: 0,
    lastMessageIndex: undefined,
    lastBackupAt: 0,
  };
}

class Database {
  cdMetrics: CooldownMetrics = defaultMetrics();
  latestStemlightReleaseTag = '';

  // Maps/Sets in memory (O(1) lookups on every message); plain arrays on disk
  private users = new Map<string, StoredUser>();
  private optedOut = new Set<string>();
  private dirty = false;
  private readonly store = new SecureStore(DATA_DIR);

  markDirty(): void {
    this.dirty = true;
  }

  isOptedOut(userId: string): boolean {
    return this.optedOut.has(userId);
  }

  getUser(userId: string): StoredUser | undefined {
    return this.users.get(userId);
  }

  recordMessage(userId: string): void {
    if (this.optedOut.has(userId)) return;
    let user = this.users.get(userId);
    if (!user) {
      user = { userId, firstSeen: Date.now(), totalMessageCount: 0 };
      this.users.set(userId, user);
    }
    user.totalMessageCount++;
    this.dirty = true;
  }

  removeUser(userId: string): void {
    if (this.users.delete(userId)) this.dirty = true;
  }

  setOptOut(userId: string, optOut: boolean): void {
    if (optOut) {
      this.optedOut.add(userId);
      this.users.delete(userId);
    } else {
      this.optedOut.delete(userId);
    }
    this.dirty = true;
    this.save(); // persist the choice immediately rather than waiting for the next interval
  }

  stats(): { users: number; optedOut: number } {
    return { users: this.users.size, optedOut: this.optedOut.size };
  }

  /** Resets the hourly counters when a new hour starts. Returns true if it did (so callers can reset theirs too). */
  rollHourIfNeeded(): boolean {
    const hour = currentEpochHour();
    if (hour === this.cdMetrics.currentHour) return false;
    this.cdMetrics.currentHour = hour;
    this.cdMetrics.botMessageCount = 0;
    this.cdMetrics.botLimitReached = false;
    return true;
  }

  save(force = false): boolean {
    if (!force && !this.dirty) return true;
    try {
      this.store.save('database', this.snapshot());
      this.dirty = false;
      return true;
    } catch (error) {
      console.error('Error saving database:', errMsg(error));
      return false;
    }
  }

  backup(): boolean {
    try {
      this.cdMetrics.lastBackupAt = Date.now();
      this.store.save('database_backup', this.snapshot());
      return true;
    } catch (error) {
      console.error('Error backing up database:', errMsg(error));
      return false;
    }
  }

  /** Loads the encrypted database (or its backup), migrating the old plaintext files if they're still around. */
  load(): void {
    const loaded = this.tryLoad('database', LEGACY_DB_PATH) ?? this.tryLoad('database_backup', LEGACY_BACKUP_PATH);
    if (loaded) {
      this.restore(loaded.data);
      console.log(`Database loaded${loaded.legacy ? ' (migrating from legacy plaintext)' : ''}`);
    } else {
      this.restore(undefined);
      console.log('Starting a fresh database');
    }

    if (this.save(true) && this.backup()) {
      // Encrypted copies are safely on disk, so the old plaintext files can go
      for (const legacyPath of [LEGACY_DB_PATH, LEGACY_BACKUP_PATH]) {
        if (fs.existsSync(legacyPath)) {
          fs.rmSync(legacyPath);
          console.log(`Removed legacy plaintext file ${path.basename(legacyPath)}`);
        }
      }
    }
  }

  private snapshot(): PersistedData {
    return {
      schemaVersion: 2,
      cdMetrics: this.cdMetrics,
      latestStemlightReleaseTag: this.latestStemlightReleaseTag,
      users: [...this.users.values()],
      optedOut: [...this.optedOut],
    };
  }

  /** Brings anything loaded from disk (including the old plaintext format) up to the current schema. */
  private restore(raw: unknown): void {
    this.cdMetrics = defaultMetrics();
    this.latestStemlightReleaseTag = '';
    this.users = new Map();
    this.optedOut = new Set();
    this.dirty = false;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;

    const data = raw as Record<string, unknown>;
    const cdValue = data.cdMetrics;
    const cd =
      cdValue !== null && typeof cdValue === 'object' && !Array.isArray(cdValue)
        ? (cdValue as Record<string, unknown>)
        : {};

    this.cdMetrics.botMessageCount = Number(cd.botMessageCount) || 0;
    this.cdMetrics.botLimitReached = Boolean(cd.botLimitReached);
    this.cdMetrics.currentHour = Number(cd.currentHour) || this.cdMetrics.currentHour;
    this.cdMetrics.lastPaperMsgTimestamp = Number(cd.lastPaperMsgTimestamp) || 0;
    this.cdMetrics.lastMessageIndex =
      typeof cd.lastMessageIndex === 'number' ? cd.lastMessageIndex : undefined;
    this.cdMetrics.lastBackupAt = Number(cd.lastBackupAt) || 0;
    this.latestStemlightReleaseTag =
      typeof data.latestStemlightReleaseTag === 'string'
        ? data.latestStemlightReleaseTag
        : '';

    if (Array.isArray(data.optedOut)) {
      for (const id of data.optedOut as unknown[]) {
        if (typeof id === 'string') this.optedOut.add(id);
      }
    }

    // Legacy records also held name/roles/channels; those are intentionally dropped here.
    if (Array.isArray(data.users)) {
      for (const value of data.users as unknown[]) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;

        const user = value as Record<string, unknown>;
        const userId = user.userId;
        if (typeof userId !== 'string' || this.optedOut.has(userId)) continue;

        this.users.set(userId, {
          userId,
          firstSeen: Number(user.firstSeen ?? user.timeJoined) || Date.now(),
          totalMessageCount: Number(user.totalMessageCount) || 0,
        });
      }
    }
  }

  private tryLoad(name: string, legacyPath: string): LoadResult | undefined {
    try {
      const data = this.store.load(name);
      if (data !== undefined) return { data, legacy: false };
    } catch (error) {
      console.error(`Could not decrypt ${name}.enc (wrong key or corrupted?): ${errMsg(error)}`);
      this.store.quarantine(name); // keep the file for recovery instead of overwriting it
    }
    if (fs.existsSync(legacyPath)) {
      try {
        return { data: JSON.parse(fs.readFileSync(legacyPath, 'utf8')), legacy: true };
      } catch (error) {
        console.error(`Could not read legacy file ${path.basename(legacyPath)}: ${errMsg(error)}`);
      }
    }
    return undefined;
  }
}

export const db = new Database();
