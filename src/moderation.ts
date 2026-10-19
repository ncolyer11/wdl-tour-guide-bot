import { find as findLinks } from 'linkifyjs';
import { GuildMember, Message, PermissionFlagsBits } from 'discord.js';
import { config } from './config';
import { clip, neutralise, sendMessage } from './utils';

type Settings = typeof config.moderation;

export interface ScoreResult {
  score: number;
  reasons: string[];
  hasLink: boolean;
}

/**
 * Scores ONE message for scam-likeness. Pure function, easy to test and tune via config.moderation.
 * A bare link scores 0 (people share links all the time); it only counts alongside another signal.
 */
export function scoreMessage(content: string, cfg: Settings = config.moderation): ScoreResult {
  const text = content.normalize('NFKC'); // folds full-width / styled characters scammers use to dodge filters
  const lower = text.toLowerCase();
  const hasLink = findLinks(text).length > 0;
  const massMention = /@(everyone|here)\b/.test(lower);
  const invite = /(discord\.gg|discord(app)?\.com\/invite)\//.test(lower);
  const strong = cfg.strongKeywords.filter(k => lower.includes(k));
  const weak = cfg.weakKeywords.filter(k => lower.includes(k));

  const reasons: string[] = [];
  const w = cfg.weights;
  let score = 0;

  const hasSignal = invite || massMention || strong.length > 0 || (hasLink && weak.length > 0);
  if (!hasSignal) return { score: 0, reasons, hasLink };

  if (hasLink) { score += w.link; reasons.push('link'); }
  if (invite) { score += w.invite; reasons.push('invite link'); }
  if (massMention) { score += w.massMention; reasons.push('@everyone/@here'); }
  const keywordScore = Math.min(w.keywordCap, strong.length * w.strongKeyword + weak.length * w.weakKeyword);
  if (keywordScore > 0) { score += keywordScore; reasons.push(`keywords: ${[...strong, ...weak].slice(0, 4).join(', ')}`); }

  return { score, reasons, hasLink };
}

/** Same text with URLs and whitespace removed, so scammers who tweak the link still get matched. */
export const fingerprint = (content: string): string => {
  const base = content.normalize('NFKC').toLowerCase();
  const withoutUrls = base.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  return withoutUrls || base.trim();
};

interface Entry<T> {
  time: number;
  channelId: string;
  fingerprint: string;
  score: number;
  reasons: string[];
  ref: T;
}

export interface Assessment<T> {
  total: number;
  reasons: string[];
  flagged: T[]; // the messages that contributed, so they can be cleaned up
}

/** In-memory only: remembers each user's recent suspicious messages so repeats and cross-channel copies add up. */
export class SpamTracker<T> {
  private entries = new Map<string, Entry<T>[]>();

  constructor(private readonly cfg: Settings = config.moderation) {}

  assess(userId: string, channelId: string, content: string, ref: T, now = Date.now()): Assessment<T> {
    const recent = (this.entries.get(userId) ?? []).filter(e => now - e.time < this.cfg.windowMs);
    const scored = scoreMessage(content, this.cfg);
    const reasons = [...scored.reasons];
    let score = scored.score;

    if (scored.score > 0 || scored.hasLink) {
      const print = fingerprint(content);
      if (recent.some(e => e.fingerprint === print && e.channelId !== channelId)) {
        score += this.cfg.weights.duplicateCrossChannel;
        reasons.push('same message in several channels');
      } else if (recent.some(e => e.fingerprint === print)) {
        score += this.cfg.weights.duplicateSameChannel;
        reasons.push('repeated message');
      }
      recent.push({ time: now, channelId, fingerprint: print, score, reasons, ref });
    }

    if (recent.length > 0) this.entries.set(userId, recent);
    else this.entries.delete(userId);

    return {
      total: recent.reduce((sum, e) => sum + e.score, 0),
      reasons: [...new Set(recent.flatMap(e => e.reasons))],
      flagged: recent.map(e => e.ref),
    };
  }

  clear(userId: string): void {
    this.entries.delete(userId);
  }

  prune(now = Date.now()): void {
    for (const [userId, list] of this.entries) {
      if (list.every(e => now - e.time >= this.cfg.windowMs)) this.entries.delete(userId);
    }
  }
}

export const spamTracker = new SpamTracker<Message<true>>();

/** Mods and the bot owner are never auto-actioned. */
export function isExempt(message: Message<true>, owner: boolean): boolean {
  if (owner) return true;
  const perms = message.member?.permissions;
  return Boolean(perms?.has(PermissionFlagsBits.ManageMessages) || perms?.has(PermissionFlagsBits.Administrator));
}

const isNewMember = (member: GuildMember): boolean =>
  member.joinedTimestamp === null || Date.now() - member.joinedTimestamp < config.moderation.newMemberDays * 86_400_000;

export type Outcome = 'timed out' | 'kicked' | 'banned' | 'alert only' | 'failed';

/**
 * Cleans up the flagged messages, disciplines the user if they're a recent joiner (everyone else just triggers
 * an alert), and reports to the mod log. Returns what happened so the caller can drop stored data on kick/ban.
 */
export async function actOnSpam(message: Message<true>, assessment: Assessment<Message<true>>): Promise<Outcome> {
  const cfg = config.moderation;
  const { member, author, guild } = message;
  const reason = `Possible scam (score ${assessment.total}): ${assessment.reasons.join('; ')}`;

  await Promise.allSettled(assessment.flagged.filter(m => m.deletable).map(m => m.delete()));

  let outcome: Outcome = 'alert only';
  if (member && isNewMember(member)) {
    try {
      if (cfg.action === 'ban' && member.bannable) {
        await member.ban({ deleteMessageSeconds: cfg.banDeleteSeconds, reason });
        outcome = 'banned';
      } else if (cfg.action === 'kick' && member.kickable) {
        await member.kick(reason);
        outcome = 'kicked';
      } else if (cfg.action === 'timeout' && member.moderatable) {
        await member.timeout(cfg.timeoutMinutes * 60_000, reason);
        outcome = 'timed out';
      } else {
        outcome = 'failed';
      }
    } catch (error) {
      console.error('Moderation action failed:', error);
      outcome = 'failed';
    }
  }

  const ping = cfg.alertRoleId ? `<@&${cfg.alertRoleId}> ` : '';
  const undo = outcome === 'timed out' ? '\n- To undo: right-click the member → Remove Timeout' : '';
  await sendMessage(guild.channels.cache.get(config.channels.modLog), {
    content:
      `${ping}**Possible scam flagged**\n- User: <@${author.id}> (${author.username}, \`${author.id}\`)\n` +
      `- Action: ${outcome}${outcome === 'alert only' ? ' (established member, review manually)' : ''}\n` +
      `- Score: ${assessment.total} (${assessment.reasons.join('; ')})\n- Channel: <#${message.channel.id}>\n` +
      `- Message: "${clip(neutralise(message.content), 800)}"${undo}`,
    allowedMentions: { parse: [], roles: cfg.alertRoleId ? [cfg.alertRoleId] : [] },
  });
  console.log(`Scam handling for ${author.id}: ${outcome}`);
  return outcome;
}
