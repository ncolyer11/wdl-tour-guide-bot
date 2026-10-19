import {
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Guild,
  GuildMember,
  Message,
  MessageCreateOptions,
  MessageFlags,
  MessageType,
  PartialGuildMember,
  SlashCommandBuilder,
  User as DiscordUser,
} from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import { find as findLinks } from 'linkifyjs';
import { SecureStore } from './secure-store';
import { safeRoles, triggerPhrases, otherPhrases, excPhrases, welcomeMessages, channelIds } from './strings';

/////////////////////////////////////////////////////////////////////////////
////////////////////////////// Configuration ////////////////////////////////
/////////////////////////////////////////////////////////////////////////////
const HOURLY_MSG_LIMIT = 10;
const HOURLY_INDV_REPLY_LIMIT = 3;
const SPAM_WINDOW_MS = 20_000;
const SPAM_MESSAGE_LIMIT = 4;
const APPROX_DISCORD_CHAR_LIMIT = 1900;
const MAX_EMBED_DESCRIPTION = 4096;
const MAX_RETRIES = 5;
const SAVE_INTERVAL_MS = 15 * 60_000;
const BACKUP_INTERVAL_MS = 12 * 60 * 60_000;
const RELEASE_POLL_MS = 15 * 60_000;
const ENABLE_RELEASE_POLLING = true;

// ---------------------------------------------------------------------------
// PRIVILEGED INTENT SWITCHES. Leave these false until Discord approves each intent
// (and it is toggled on in the Developer Portal), then flip it to true and restart.
//
//  USE_MESSAGE_CONTENT_INTENT = false -> the bot can't read message text, so these are OFF:
//      trigger-phrase replies, "paper" reply, scam auto-ban, deleted-message log, !owner commands.
//  USE_GUILD_MEMBERS_INTENT   = false -> no join/leave events, so:
//      welcomes fall back to Discord's own join message, and NO per-user data is stored
//      (without leave events we couldn't delete it when people leave).
// ---------------------------------------------------------------------------
const USE_MESSAGE_CONTENT_INTENT = false;
const USE_GUILD_MEMBERS_INTENT = false;

const archiveChannel = '1019870085617291305';
const testingChannelId = '1094609234978668765';
const mathsAndCodeChannelId = '1036212683374088283';
const chunkManipulationChannelId = '930048455777325076';
const welcomeChannelId = channelIds[2];
const STEMLIGHT_REPO = 'ncolyer11/Stemlight';

// Owners: comma-separated Discord user IDs in OWNER_USER_IDS (env). The role-name fallback is kept for
// backwards compatibility, but IDs are safer because role/user names can be changed or impersonated.
const OWNER_USER_IDS = new Set((process.env.OWNER_USER_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean));
const OWNER_ROLE_NAME = 'slightly different shade of cyan';

const DATA_DIR = path.join(__dirname, '..', 'data');
const LEGACY_DB_PATH = path.join(__dirname, 'database.json');
const LEGACY_BACKUP_PATH = path.join(__dirname, 'database_backup.json');

/////////////////////////////////////////////////////////////////////////////
///////////////////////////////// Types /////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////
type GuildMessage = Message<true>;

/** The only per-user data that is ever persisted (encrypted). No names, roles or message content. */
export interface StoredUser {
  userId: string;
  firstSeen: number;
  totalMessageCount: number;
}

interface CooldownMetrics {
  botMessageCount: number;
  botLimitReached: boolean;
  currentHour: number; // hours since the epoch
  lastPaperMsgTimestamp: number;
  lastMessageIndex: number | undefined;
  lastBackupAt: number;
}

interface DataStore {
  schemaVersion: 2;
  cdMetrics: CooldownMetrics;
  latestStemlightReleaseTag: string;
  users: StoredUser[];
  optedOut: string[]; // user IDs that asked not to have data stored
}

interface GithubRelease {
  tag_name: string;
  body?: string | null;
  html_url: string;
}

/////////////////////////////////////////////////////////////////////////////
///////////////////////////// Runtime-only state ////////////////////////////
/////////////////////////////////////////////////////////////////////////////
// Never written to disk. These reset on restart, which is intentional (data minimisation).
const replyCounts = new Map<string, number>(); // userId -> bot replies this hour
const suspiciousTimestamps = new Map<string, number[]>(); // userId -> recent scam-looking message times

let dataStore: DataStore = getDefaultDataStore();
const store = new SecureStore(DATA_DIR);

function currentEpochHour(): number {
  return Math.floor(Date.now() / 3_600_000);
}

function getDefaultDataStore(): DataStore {
  return {
    schemaVersion: 2,
    cdMetrics: {
      botMessageCount: 0,
      botLimitReached: false,
      currentHour: currentEpochHour(),
      lastPaperMsgTimestamp: 0,
      lastMessageIndex: undefined,
      lastBackupAt: 0,
    },
    latestStemlightReleaseTag: '',
    users: [],
    optedOut: [],
  };
}

const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const neutralise = (text: string): string => text.replace(/@(everyone|here)/g, '`@$1`');

function readSecret(envVar: string, fileName: string): string | undefined {
  const fromEnv = process.env[envVar]?.trim();
  if (fromEnv) return fromEnv;
  const file = path.join(__dirname, fileName);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() || undefined : undefined;
}

/////////////////////////////////////////////////////////////////////////////
////////////////////////////////// Client ///////////////////////////////////
/////////////////////////////////////////////////////////////////////////////
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
if (USE_GUILD_MEMBERS_INTENT) intents.push(GatewayIntentBits.GuildMembers); // privileged: welcomes + leave cleanup
if (USE_MESSAGE_CONTENT_INTENT) intents.push(GatewayIntentBits.MessageContent); // privileged: triggers + scam detection

const client = new Client({
  intents,
  allowedMentions: { parse: ['users'] }, // never @everyone/@here or roles unless a call opts in
});

/////////////////////////////////////////////////////////////////////////////
//////////////////////////////// Event handlers /////////////////////////////
/////////////////////////////////////////////////////////////////////////////
client.once(Events.ClientReady, async readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(
    `Mode: message content ${USE_MESSAGE_CONTENT_INTENT ? 'ON' : 'OFF'}, ` +
    `server members ${USE_GUILD_MEMBERS_INTENT ? 'ON' : 'OFF'}` +
    (USE_MESSAGE_CONTENT_INTENT && USE_GUILD_MEMBERS_INTENT ? '' : ' (lightweight mode, some features disabled)')
  );
  await registerCommands();
  await sendBotOnlineMessage();

  setInterval(() => void runSetTasks(), SAVE_INTERVAL_MS);

  // Give the bot a moment to settle, then check Stemlight releases
  await new Promise(res => setTimeout(res, 5000));
  await runReleaseCheck();
  if (ENABLE_RELEASE_POLLING) setInterval(() => void runReleaseCheck(), RELEASE_POLL_MS);
});

async function welcomeMember(member: GuildMember): Promise<void> {
  try {
    if (member.user.bot) return;

    // Pick a weighted-random welcome message, never the same one twice in a row
    const rarities = [7, 3, 3, 3, 1, 2, 3, 4, 4, 4, 3, 3, 6, 3, 1, 4, 2, 7, 7, 5, 2, 6, 7, 3, 4, 6, 5];
    let index = weightedRandomIndex(rarities);
    while (index === dataStore.cdMetrics.lastMessageIndex && rarities.length > 1) {
      index = weightedRandomIndex(rarities);
    }
    dataStore.cdMetrics.lastMessageIndex = index;

    const text = welcomeMessages[index]
      .replaceAll('{member}', `<@${member.id}>`)
      .replaceAll('{archive}', `<#${archiveChannel}>`)
      .replaceAll('{Froge}', '<:Froge:930083494938411018>');
    await sendMessage(member.guild.systemChannel, text);
    console.log(`Sent welcome message for ${member.id}`);

    await dmUser(member);
  } catch (error) {
    console.error('welcomeMember failed:', errMsg(error));
  }
}

client.on(Events.GuildMemberAdd, member => void welcomeMember(member)); // needs the Server Members intent

client.on(Events.GuildMemberRemove, async (member: GuildMember | PartialGuildMember) => {
  try {
    const label = member.user?.tag ?? member.id;
    await sendMessage(member.guild.channels.cache.get(testingChannelId), `${label} has left the server.`);
    // They're gone, so we no longer need anything about them (their opt-out choice is kept)
    removeUserData(member.id);
    suspiciousTimestamps.delete(member.id);
  } catch (error) {
    console.error('guildMemberRemove failed:', errMsg(error));
  }
});

client.on(Events.MessageDelete, async message => {
  try {
    if (!USE_MESSAGE_CONTENT_INTENT) return;
    const author = message.author;
    if (!author || author.bot || !message.guild || message.content == null) return;
    if (isOptedOut(author.id)) return; // respect opt-outs: don't copy their deleted messages anywhere

    const logChannel = message.guild.channels.cache.get(testingChannelId);
    if (!logChannel || message.content.length >= APPROX_DISCORD_CHAR_LIMIT) return;

    await sendMessage(logChannel, {
      content:
        `**Deleted Message:**\n- User: *${author.username}*\n- Channel: ${message.channel}\n` +
        `- Message: "${neutralise(message.content)}"`,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('messageDelete failed:', errMsg(error));
  }
});

client.on(Events.MessageCreate, async message => {
  try {
    if (!message.inGuild()) return; // ignore DMs

    // Lightweight mode: no member-join event, so welcome off Discord's own "X joined" system message
    if (!USE_GUILD_MEMBERS_INTENT && message.type === MessageType.UserJoin) {
      const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
      if (member) await welcomeMember(member);
      return;
    }

    const owner = isOwner(message);
    if (owner && USE_MESSAGE_CONTENT_INTENT) await handleOwnerCommand(message);

    // Keep #chunk-manipulation clean (owner-only channel)
    if (message.channel.id === chunkManipulationChannelId && !owner) {
      await message.delete().catch(error => console.error('Error deleting message:', errMsg(error)));
      return;
    }

    if (message.author.bot || message.webhookId || message.system) return;

    // Only store per-user data when we can also delete it on leave (needs the Server Members intent)
    if (USE_GUILD_MEMBERS_INTENT) recordMessage(message.author.id); // no-op for opted-out users

    if (!USE_MESSAGE_CONTENT_INTENT) return; // everything below needs to read message text

    if (await checkBan(message)) return;
    await checkUserMessageForResponse(message, owner);
  } catch (error) {
    console.error('messageCreate failed:', errMsg(error));
  }
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'privacy') {
      await handlePrivacyCommand(interaction);
    }
  } catch (error) {
    console.error('interactionCreate failed:', errMsg(error));
  }
});

/////////////////////////////////////////////////////////////////////////////
///////////////////////////// Privacy commands //////////////////////////////
/////////////////////////////////////////////////////////////////////////////
const privacyCommand = new SlashCommandBuilder()
  .setName('privacy')
  .setDescription('See or control the data this bot stores about you')
  .addSubcommand(s => s.setName('info').setDescription('What this bot stores, why, and for how long'))
  .addSubcommand(s => s.setName('mydata').setDescription('Show exactly what is stored about you'))
  .addSubcommand(s => s.setName('optout').setDescription('Stop storing data about you and delete what exists'))
  .addSubcommand(s => s.setName('optin').setDescription('Allow the bot to store basic activity data about you again'));

const PRIVACY_INFO = [
  '**What this bot stores (encrypted at rest with AES-256-GCM):**',
  '• Your Discord user ID, when it first saw you, and how many messages you have sent.',
  '',
  '**What it does NOT store:** message content, usernames, roles, or anything about DMs.',
  '',
  '**Short-lived, memory-only (lost on restart):** timestamps used for scam detection (about 20 seconds) ' +
    'and reply rate limits (1 hour). These keep running even if you opt out, so the anti-scam filter ' +
    'cannot be dodged, but nothing about them is saved.',
  '',
  '**Deleted-message log:** when someone deletes a message, a copy goes to the moderators\' log channel. ' +
    'Opted-out users are excluded.',
  '',
  '**Retention:** your record is deleted when you leave the server, when you opt out, or when you are banned.',
  '',
  'Use `/privacy mydata` to see your record, `/privacy optout` to stop storage and delete it, ' +
    'or `/privacy optin` to allow it again.',
].join('\n');

async function handlePrivacyCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;
  let content: string;

  switch (interaction.options.getSubcommand()) {
    case 'info':
      content = PRIVACY_INFO;
      break;
    case 'mydata': {
      const record = dataStore.users.find(u => u.userId === userId);
      content = isOptedOut(userId)
        ? 'You have **opted out**. Nothing is stored about you except that opt-out choice.'
        : record
          ? `Stored about you:\n\`\`\`json\n${JSON.stringify(
              { userId: record.userId, firstSeen: new Date(record.firstSeen).toISOString(), totalMessageCount: record.totalMessageCount },
              null, 2)}\n\`\`\``
          : 'Nothing is stored about you right now.';
      break;
    }
    case 'optout':
      setOptOut(userId, true);
      content = 'Done. Your stored data has been deleted and nothing further will be stored about you.';
      break;
    case 'optin':
      setOptOut(userId, false);
      content = 'Done. The bot may store basic activity data about you again. See `/privacy info` for details.';
      break;
    default:
      content = 'Unknown option.';
  }
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function registerCommands(): Promise<void> {
  try {
    await client.application?.commands.set([privacyCommand.toJSON()]);
    console.log('Slash commands registered');
  } catch (error) {
    console.error(
      'Could not register slash commands. If this says "Missing Access", re-invite the bot with the ' +
      '"applications.commands" scope:', errMsg(error)
    );
  }
}

/////////////////////////////////////////////////////////////////////////////
//////////////////////////// Data store operations //////////////////////////
/////////////////////////////////////////////////////////////////////////////
const isOptedOut = (userId: string): boolean => dataStore.optedOut.includes(userId);

function recordMessage(userId: string): void {
  if (isOptedOut(userId)) return;
  let user = dataStore.users.find(u => u.userId === userId);
  if (!user) {
    user = { userId, firstSeen: Date.now(), totalMessageCount: 0 };
    dataStore.users.push(user);
  }
  user.totalMessageCount++;
}

function removeUserData(userId: string): void {
  dataStore.users = dataStore.users.filter(u => u.userId !== userId);
}

function setOptOut(userId: string, optOut: boolean): void {
  if (optOut) {
    if (!isOptedOut(userId)) dataStore.optedOut.push(userId);
    removeUserData(userId);
  } else {
    dataStore.optedOut = dataStore.optedOut.filter(id => id !== userId);
  }
  saveDatabase(); // persist the choice immediately rather than waiting for the next interval
}

/** Brings anything loaded from disk (including the old plaintext format) up to the current schema. */
function normaliseStore(raw: unknown): DataStore {
  const result = getDefaultDataStore();
  if (!raw || typeof raw !== 'object') return result;
  const data = raw as Record<string, any>;

  const cd = data.cdMetrics ?? {};
  result.cdMetrics.botMessageCount = Number(cd.botMessageCount) || 0;
  result.cdMetrics.botLimitReached = Boolean(cd.botLimitReached);
  result.cdMetrics.currentHour = Number(cd.currentHour) || result.cdMetrics.currentHour;
  result.cdMetrics.lastPaperMsgTimestamp = Number(cd.lastPaperMsgTimestamp) || 0;
  result.cdMetrics.lastMessageIndex = typeof cd.lastMessageIndex === 'number' ? cd.lastMessageIndex : undefined;
  result.cdMetrics.lastBackupAt = Number(cd.lastBackupAt) || 0;
  result.latestStemlightReleaseTag = typeof data.latestStemlightReleaseTag === 'string' ? data.latestStemlightReleaseTag : '';

  result.optedOut = Array.isArray(data.optedOut) ? data.optedOut.filter((id): id is string => typeof id === 'string') : [];

  // Legacy records also held name/roles/channels; those are intentionally dropped here.
  if (Array.isArray(data.users)) {
    result.users = data.users
      .filter((u: any) => u && typeof u.userId === 'string' && !result.optedOut.includes(u.userId))
      .map((u: any): StoredUser => ({
        userId: u.userId,
        firstSeen: Number(u.firstSeen ?? u.timeJoined) || Date.now(),
        totalMessageCount: Number(u.totalMessageCount) || 0,
      }));
  }
  return result;
}

interface LoadResult { data: unknown; legacy: boolean }

function tryLoad(name: string, legacyPath: string): LoadResult | undefined {
  try {
    const data = store.load(name);
    if (data !== undefined) return { data, legacy: false };
  } catch (error) {
    console.error(`Could not decrypt ${name}.enc (wrong key or corrupted?): ${errMsg(error)}`);
    store.quarantine(name); // keep the file for recovery instead of overwriting it
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

function loadDatabase(): void {
  const loaded = tryLoad('database', LEGACY_DB_PATH) ?? tryLoad('database_backup', LEGACY_BACKUP_PATH);
  if (loaded) {
    dataStore = normaliseStore(loaded.data);
    console.log(`Database loaded${loaded.legacy ? ' (migrating from legacy plaintext)' : ''}`);
  } else {
    dataStore = getDefaultDataStore();
    console.log('Starting a fresh database');
  }

  if (saveDatabase() && backupDatabase()) {
    // Encrypted copies are safely on disk, so the old plaintext files can go
    for (const legacyPath of [LEGACY_DB_PATH, LEGACY_BACKUP_PATH]) {
      if (fs.existsSync(legacyPath)) {
        fs.rmSync(legacyPath);
        console.log(`Removed legacy plaintext file ${path.basename(legacyPath)}`);
      }
    }
  }
}

function saveDatabase(): boolean {
  try {
    rollHourIfNeeded();
    store.save('database', dataStore);
    return true;
  } catch (error) {
    console.error('Error saving database:', errMsg(error));
    return false;
  }
}

function backupDatabase(): boolean {
  try {
    store.save('database_backup', dataStore);
    dataStore.cdMetrics.lastBackupAt = Date.now();
    return true;
  } catch (error) {
    console.error('Error backing up database:', errMsg(error));
    return false;
  }
}

async function runSetTasks(): Promise<void> {
  dataStore.users = dataStore.users.filter(u => u.totalMessageCount > 0);
  dataStore.users.sort((a, b) => b.totalMessageCount - a.totalMessageCount);

  const now = Date.now();
  for (const [userId, times] of suspiciousTimestamps) {
    if (times.every(t => now - t >= SPAM_WINDOW_MS)) suspiciousTimestamps.delete(userId);
  }

  if (now - dataStore.cdMetrics.lastBackupAt >= BACKUP_INTERVAL_MS) backupDatabase();
  saveDatabase();
}

function rollHourIfNeeded(): void {
  const hour = currentEpochHour();
  if (hour !== dataStore.cdMetrics.currentHour) {
    dataStore.cdMetrics.currentHour = hour;
    dataStore.cdMetrics.botMessageCount = 0;
    dataStore.cdMetrics.botLimitReached = false;
    replyCounts.clear();
  }
}

/////////////////////////////////////////////////////////////////////////////
///////////////////////////// Responding to users ///////////////////////////
/////////////////////////////////////////////////////////////////////////////
const FARM_EXCLUSIONS = excPhrases.map(phrase =>
  // Plain words/numbers get word boundaries; anything else (e.g. a double quote) is a simple substring test
  /^[\w,]+$/.test(phrase) ? new RegExp(`\\b${phrase}\\b`, 'i') : { test: (text: string) => text.includes(phrase) }
);

function matchesTrigger(content: string): boolean {
  const cleaned = content.toLowerCase().replace(/['",.\-`()]/g, '');
  return triggerPhrases.some(phrase => cleaned.includes(phrase));
}

function matchesFarmQuestion(content: string): boolean {
  const lower = content.toLowerCase();
  return otherPhrases.some(phrase => lower.includes(phrase)) && !FARM_EXCLUSIONS.some(re => re.test(content));
}

async function reply(message: GuildMessage, text: string, reason: string): Promise<void> {
  await sendMessage(message.channel, text);
  console.log(`Sent reply #${dataStore.cdMetrics.botMessageCount + 1} (${reason})`);
  dataStore.cdMetrics.botMessageCount++;
  replyCounts.set(message.author.id, (replyCounts.get(message.author.id) ?? 0) + 1);
}

async function checkUserMessageForResponse(message: GuildMessage, owner: boolean): Promise<void> {
  let replied = false;

  if (!owner && await canReply(message, true)) {
    if (matchesTrigger(message.content)) {
      await reply(message, `Hey ${message.author}, please see <#${archiveChannel}> for all world downloads and schematics.`, 'world download');
      replied = true;
    } else if (matchesFarmQuestion(message.content)) {
      await reply(
        message,
        `Hey ${message.author}, this server has many different tree farm designs by many different people.\n\n` +
        'Please include the name of the farm you need help with.',
        'tree farm'
      );
      replied = true;
    }
  }

  if (!replied && message.content.toLowerCase().includes('paper') && (owner || await canReply(message, false))) {
    const now = Date.now();
    if (now - dataStore.cdMetrics.lastPaperMsgTimestamp >= 60_000) { // 1 minute cooldown
      const timestamp = Math.random() < 0.1 ? 14 : 1128;
      dataStore.cdMetrics.lastPaperMsgTimestamp = now;
      await reply(message, `[paper lol](<https://youtube.com/watch?v=XjjXYrMK4qw&t=${timestamp}s>)`, 'paper');
    }
  }
}

async function canReply(message: GuildMessage, restrictToChannels: boolean): Promise<boolean> {
  rollHourIfNeeded();

  if (dataStore.cdMetrics.botMessageCount >= HOURLY_MSG_LIMIT) {
    if (!dataStore.cdMetrics.botLimitReached) {
      console.log(`Reached hourly message limit (${dataStore.cdMetrics.botMessageCount})`);
      dataStore.cdMetrics.botLimitReached = true;
    }
    return false;
  }

  const userId = message.author.id;
  const count = replyCounts.get(userId) ?? 0;
  if (count >= HOURLY_INDV_REPLY_LIMIT) {
    if (count === HOURLY_INDV_REPLY_LIMIT) {
      await sendMessage(message.channel, `Hey ${message.author}, please relax your use of my features.`);
      replyCounts.set(userId, count + 1); // so the warning is only sent once
    }
    return false;
  }

  if (restrictToChannels && !channelIds.includes(message.channel.id)) return false;
  if (message.member?.roles.cache.some(role => safeRoles.includes(role.name))) return false;
  return true;
}

function weightedRandomIndex(weights: number[]): number {
  const total = weights.reduce((acc, w) => acc + w, 0);
  let random = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    random -= weights[i];
    if (random < 0) return i;
  }
  return 0;
}

async function dmUser(member: GuildMember): Promise<void> {
  const prefix = 'https://discord.com/channels/930027805398429736/';
  const dmMessage =
`Hi, thanks for joining <:warped_fungus:1264941277779333242> Huge Fungi Huggers <:crimson_fungus:1264941397056819321>!

Here are some shortcuts to help you on your nether tree farming journey:
 <:warped_stem:1264941326621999215>  [**12 Type Tree Farm Download**](${prefix}1221071923803586560)
 <:crimson_stem:1264941385673605150>  [**Simple & Rapid Nether Tree Farm Download**](${prefix}1096118419201462303)
 <:shroomlight:1264941341129834528>  [**All Farm World Downloads & Schematics**](${prefix}1019870085617291305)

-# The bot keeps a minimal, encrypted message count per user. Use /privacy info to see details or /privacy optout to opt out.`;
  try {
    await member.send(dmMessage);
  } catch {
    console.error(`Could not DM ${member.id}; they likely don't accept DMs.`);
  }
}

async function sendMessage(channel: unknown, content: string | MessageCreateOptions): Promise<boolean> {
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

/////////////////////////////////////////////////////////////////////////////
/////////////////////////////// Scam handling ///////////////////////////////
/////////////////////////////////////////////////////////////////////////////
const SUSPICIOUS_KEYWORDS = [
  '@everyone', '@here', 'steam', 'discord', 'discord nitro', 'free nitro', 'free gift',
  'free giveaway', 'free money', 'hack', 'bitcoin', 'crypto', 'gift', '$',
];

// In-memory only: how many scam-looking messages has this user sent in the last SPAM_WINDOW_MS?
function trackSuspicious(message: GuildMessage): number {
  const now = Date.now();
  const id = message.author.id;
  const recent = (suspiciousTimestamps.get(id) ?? []).filter(t => now - t < SPAM_WINDOW_MS);

  const lower = message.content.toLowerCase();
  if (findLinks(message.content).length > 0 && SUSPICIOUS_KEYWORDS.some(k => lower.includes(k))) {
    recent.push(now);
  }

  if (recent.length > 0) suspiciousTimestamps.set(id, recent);
  else suspiciousTimestamps.delete(id);
  return recent.length;
}

/** Returns true if the author was banned/kicked (so the caller should stop handling the message). */
async function checkBan(message: GuildMessage): Promise<boolean> {
  if (trackSuspicious(message) < SPAM_MESSAGE_LIMIT) return false;
  const acted = await banUser(message.guild, message.author, message.channel, message.content);
  if (acted) suspiciousTimestamps.delete(message.author.id);
  return acted;
}

async function banUser(guild: Guild, user: DiscordUser, channel: GuildMessage['channel'], content: string): Promise<boolean> {
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return false;

  let action: 'banned' | 'kicked' | null = null;
  try {
    if (member.bannable) {
      await member.ban({ deleteMessageSeconds: 60 * 60 * 24 * 7, reason: 'Bot detected violation of rules' });
      action = 'banned';
      await sendBanMessage(user, channel);
    }
  } catch (error) {
    console.error('Ban failed, trying kick:', errMsg(error));
  }
  if (!action && member.kickable) {
    try {
      await member.kick('Bot detected violation of rules');
      action = 'kicked';
    } catch (error) {
      console.error('Kick failed:', errMsg(error));
    }
  }
  if (!action) {
    console.warn(`Could not ban or kick ${user.id} (missing permission or higher role).`);
    return false;
  }

  removeUserData(user.id);
  console.log(`${action} member ${user.id}`);
  const channelLabel = channel.name;
  await sendMessage(guild.channels.cache.get(testingChannelId), {
    content:
      `**Moderation action:**\n- ${action === 'banned' ? 'Banned' : 'Kicked'} User: *${user.username}*\n` +
      `- Channel: ${channelLabel}\n- Message: "${clip(neutralise(content), 1000)}"`,
    allowedMentions: { parse: [] },
  });
  return true;
}

async function sendBanMessage(user: DiscordUser, channel: unknown): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor('#111111')
    .setTitle(`🔨 Banned User: ${user.username} 🚫`)
    .setDescription("Looks like they won't be spamming any longer");
  await sendMessage(channel, { embeds: [embed] });
}

/////////////////////////////////////////////////////////////////////////////
////////////////////////////// Owner commands ///////////////////////////////
/////////////////////////////////////////////////////////////////////////////
function isOwner(message: GuildMessage): boolean {
  if (OWNER_USER_IDS.has(message.author.id)) return true;
  return Boolean(message.member?.roles.cache.some(role => role.name === OWNER_ROLE_NAME));
}

async function handleOwnerCommand(message: GuildMessage): Promise<void> {
  const [command] = message.content.trim().split(/\s+/);
  switch (command) {
    case '!prune':
      await pruneMessages(message);
      break;
    case '!data':
      // Summary only: never dump user records into the console/log files
      console.log({
        users: dataStore.users.length,
        optedOut: dataStore.optedOut.length,
        cdMetrics: dataStore.cdMetrics,
        latestStemlightReleaseTag: dataStore.latestStemlightReleaseTag,
      });
      saveDatabase();
      await message.reply('Server data saved; summary printed to console.');
      break;
    case '!backup':
      saveDatabase();
      await message.reply(backupDatabase() ? 'Server data successfully backed up.' : 'Error backing up server data.');
      break;
    case '!reload':
      loadDatabase();
      await message.reply('Server data reloaded.');
      break;
  }
}

async function pruneMessages(message: GuildMessage): Promise<void> {
  const channel = message.channel;
  if (!('bulkDelete' in channel) || !('awaitMessages' in channel)) {
    await message.reply("I can't bulk delete in this kind of channel.");
    return;
  }

  const parsed = parseInt(message.content.split(/\s+/)[1] ?? '', 10);
  let count = 1;
  if (Number.isNaN(parsed)) {
    await message.reply("Since you didn't specify a number, I'll just prune the last message.\nType `confirm` to proceed.");
  } else if (parsed < 1 || parsed > 50) {
    await message.reply('Please specify a number between 1 and 50 and try again.');
    return;
  } else {
    count = parsed;
    await sendMessage(channel, `Are you sure you want to prune the last ${count} messages? Type \`confirm\` to proceed.`);
  }

  // Wait 7 seconds for the same person to type "confirm"
  const confirmation = await channel.awaitMessages({
    filter: m => m.author.id === message.author.id && m.content.toLowerCase() === 'confirm',
    max: 1,
    time: 7_000,
  }).catch(() => null);
  if (!confirmation || confirmation.size === 0) {
    await message.reply('Confirmation timed out. Operation canceled.');
    return;
  }

  try {
    // +3 also removes the command, the confirmation prompt and the "confirm" reply
    const recent = await channel.messages.fetch({ limit: count + 3 });
    await channel.bulkDelete(recent, true); // true = skip messages older than 14 days instead of throwing
    const done = await channel.send(`✅ Successfully pruned the last ${count === 1 ? 'message' : `${count} messages`} ✂`);
    setTimeout(() => done.delete().catch(error => console.error('Error deleting confirmation:', errMsg(error))), 5000);
  } catch (error) {
    console.error('Error bulk deleting messages:', errMsg(error));
  }
}

/////////////////////////////////////////////////////////////////////////////
///////////////////////////// Bot status messages ///////////////////////////
/////////////////////////////////////////////////////////////////////////////
async function sendBotOnlineMessage(): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor('#00CCEE')
    .setTitle('🤖 Bot Online ⚡')
    .setDescription('Ready to give some wdl tours! 🚀');
  await sendMessage(client.channels.cache.get(welcomeChannelId), { embeds: [embed] });
}

async function sendBotOfflineMessage(): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor('#E90022')
    .setTitle('🤖 Bot Offline 🌳')
    .setDescription('Good luck w/o me :)');
  await sendMessage(client.channels.cache.get(welcomeChannelId), { embeds: [embed] });
}

/////////////////////////////////////////////////////////////////////////////
//////////////////////////// Stemlight release check ////////////////////////
/////////////////////////////////////////////////////////////////////////////
const GITHUB_PAT = readSecret('GITHUB_PAT', 'PAT.txt'); // optional: public repos work unauthenticated (60 req/hour)

async function runReleaseCheck(): Promise<void> {
  console.log('Checking for new Stemlight releases...');
  const found = await checkForNewRelease();
  console.log(found ? `New release found: ${dataStore.latestStemlightReleaseTag}` : 'No new releases found.');
}

async function checkForNewRelease(): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const headers: Record<string, string> = {
        'User-Agent': 'World Download Bot',
        Accept: 'application/vnd.github+json',
      };
      if (GITHUB_PAT) headers.Authorization = `Bearer ${GITHUB_PAT}`;

      const response = await fetch(`https://api.github.com/repos/${STEMLIGHT_REPO}/releases/latest`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        if ([403, 429].includes(response.status) && response.headers.get('x-ratelimit-remaining') === '0') {
          console.warn('GitHub rate limit reached; will try again at the next scheduled check.');
          return false;
        }
        throw new Error(`GitHub API responded with status ${response.status}`);
      }

      const release = (await response.json()) as GithubRelease;
      if (release.tag_name === dataStore.latestStemlightReleaseTag) return false;

      // First ever run: just remember the current release instead of announcing an old one
      const firstRun = dataStore.latestStemlightReleaseTag === '';
      dataStore.latestStemlightReleaseTag = release.tag_name;
      if (!firstRun) await announceRelease(release);
      saveDatabase();
      return !firstRun;
    } catch (error) {
      console.error(`Release check attempt ${attempt} failed: ${errMsg(error)}`);
      if (attempt < MAX_RETRIES) await new Promise(res => setTimeout(res, 5000 * attempt));
      else console.error('Max retries reached. Giving up until the next check.');
    }
  }
  return false;
}

async function announceRelease(release: GithubRelease): Promise<void> {
  const channel = client.channels.cache.get(mathsAndCodeChannelId);
  if (!channel) return;

  let body = release.body ?? '';
  const images = extractImages(body).slice(0, 9); // Discord allows 10 embeds per message
  for (const image of images) body = body.split(image.markdown).join('  - *see attached image*');

  const embeds = [
    new EmbedBuilder()
      .setColor('#00a7a3')
      .setTitle(`New Stemlight Release: ${release.tag_name}`)
      .setDescription(clip(body, MAX_EMBED_DESCRIPTION) || null)
      .setURL(release.html_url),
    ...images.map(image => new EmbedBuilder().setImage(image.url)),
  ];
  await sendMessage(channel, { embeds });
}

function extractImages(markdown: string): { markdown: string; url: string }[] {
  const results: { markdown: string; url: string }[] = [];
  for (const match of markdown.matchAll(/!\[[^\]]*\]\((https:\/\/[^)\s]+)[^)]*\)/g)) {
    results.push({ markdown: match[0], url: match[1] });
  }
  return results;
}

/////////////////////////////////////////////////////////////////////////////
///////////////////////////// Lifecycle & startup ///////////////////////////
/////////////////////////////////////////////////////////////////////////////
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, bot is closing...`);
  setTimeout(() => process.exit(1), 10_000).unref(); // never hang forever
  saveDatabase();
  backupDatabase();
  await sendBotOfflineMessage();
  await client.destroy();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM')); // what systemd, docker and pm2 send

process.on('unhandledRejection', reason => console.error('Unhandled rejection:', reason));

const token = readSecret('DISCORD_TOKEN', 'token.txt');
if (!token) throw new Error('No bot token found. Set DISCORD_TOKEN or create src/token.txt.');

loadDatabase(); // before login, so no event can arrive while the data isn't loaded
void client.login(token);