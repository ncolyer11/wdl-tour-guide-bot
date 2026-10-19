import { MessageCreateOptions } from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';

export const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);
export const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
export const neutralise = (text: string): string => text.replace(/@(everyone|here)/g, '`@$1`');

const envOwnerIds = (process.env.OWNER_USER_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
export const isOwnerUserId = (id: string): boolean => config.owners.userIds.includes(id) || envOwnerIds.includes(id);

/** Picks an index at random, proportional to the weights. */
export function weightedIndex(weights: number[]): number {
  const total = weights.reduce((acc, w) => acc + w, 0);
  let random = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    random -= weights[i];
    if (random < 0) return i;
  }
  return 0;
}

/** Env var first, then a file next to the source (kept so your existing token.txt / PAT.txt keep working). */
export function readSecret(envVar: string, fileName: string): string | undefined {
  const fromEnv = process.env[envVar]?.trim();
  if (fromEnv) return fromEnv;
  const file = path.join(__dirname, fileName);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() || undefined : undefined;
}

/** Sends to anything with a .send(); never throws. Returns whether it worked. */
export async function sendMessage(channel: unknown, content: string | MessageCreateOptions): Promise<boolean> {
  const target = channel as { send?: (c: string | MessageCreateOptions) => Promise<unknown> } | null | undefined;
  if (!target || typeof target.send !== 'function') return false;
  try {
    await target.send(content);
    return true;
  } catch (error) {
    const preview = typeof content === 'string' ? content.slice(0, 30) : '[message options]';
    console.error('Error sending message:', preview, '\n', errMsg(error));
    return false;
  }
}
