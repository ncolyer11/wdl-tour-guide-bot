import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  GuildMember,
  Message,
  MessageType,
  PartialGuildMember,
} from 'discord.js';
import { commandDefinitions, handleInteraction } from './commands';
import { config } from './config';
import { db } from './database';
import { matchesFarmQuestion, matchesHelpRequest, mentionsPaper } from './help-matching';
import { actOnSpam, isExempt, spamTracker } from './moderation';
import { startReleasePolling } from './releases';
import { buildShortcutsText, welcomeMessages } from './strings';
import { errMsg, neutralise, readSecret, sendMessage, weightedIndex } from './utils';

type GuildMessage = Message<true>;

/////////////////////////////////////////////////////////////////////////////
////////////////////////////////// Client ///////////////////////////////////
/////////////////////////////////////////////////////////////////////////////
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
if (config.intents.guildMembers) intents.push(GatewayIntentBits.GuildMembers); // privileged
if (config.intents.messageContent) intents.push(GatewayIntentBits.MessageContent); // privileged

const client = new Client({
  intents,
  allowedMentions: { parse: ['users'] }, // never @everyone/@here or roles unless a call opts in
});

// Runtime-only (never saved): bot replies per user this hour, for rate limiting
const replyCounts = new Map<string, number>();

function isOwner(message: GuildMessage): boolean {
  return (
    config.owners.userIds.includes(message.author.id) ||
    Boolean(message.member?.roles.cache.some(role => config.owners.roleNames.includes(role.name)))
  );
}

/////////////////////////////////////////////////////////////////////////////
//////////////////////////////// Event handlers /////////////////////////////
/////////////////////////////////////////////////////////////////////////////
client.once(Events.ClientReady, async readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  const { messageContent, guildMembers } = config.intents;
  console.log(
    `Mode: message content ${messageContent ? 'ON' : 'OFF'}, server members ${guildMembers ? 'ON' : 'OFF'}` +
    (messageContent && guildMembers ? '' : ' (lightweight mode, some features disabled)')
  );

  try {
    await client.application?.commands.set(commandDefinitions);
    console.log('Slash commands registered');
  } catch (error) {
    console.error('Could not register slash commands (if "Missing Access", re-invite with the applications.commands scope):', errMsg(error));
  }

  await announceStatus('#00CCEE', '🤖 Bot Online ⚡', 'Ready to give some wdl tours! 🚀');
  setInterval(() => void runScheduledTasks(), config.limits.saveIntervalMs);
  setTimeout(() => startReleasePolling(client), 5000);
});

async function welcomeMember(member: GuildMember): Promise<void> {
  try {
    if (member.user.bot) return;

    // Weighted-random message, never the same one twice in a row
    const weights = welcomeMessages.map(m => m.weight);
    let index = weightedIndex(weights);
    while (index === db.cdMetrics.lastMessageIndex && weights.length > 1) index = weightedIndex(weights);
    db.cdMetrics.lastMessageIndex = index;
    db.markDirty();

    const text = welcomeMessages[index].text
      .replaceAll('{member}', `<@${member.id}>`)
      .replaceAll('{archive}', `<#${config.channels.archive}>`)
      .replaceAll('{Froge}', config.emojis.froge);
    await sendMessage(member.guild.systemChannel, text);

    try {
      await member.send(
        'Hi, thanks for joining <:warped_fungus:1264941277779333242> Huge Fungi Huggers <:crimson_fungus:1264941397056819321>!\n\n' +
        `Here are some shortcuts to help you on your nether tree farming journey:\n${buildShortcutsText()}\n\n` +
        '-# The bot keeps a minimal, encrypted message count per user. Use /privacy info to see details or /privacy optout to opt out.'
      );
    } catch {
      console.error(`Could not DM ${member.id}; they likely don't accept DMs.`);
    }
  } catch (error) {
    console.error('welcomeMember failed:', errMsg(error));
  }
}

client.on(Events.GuildMemberAdd, member => void welcomeMember(member)); // needs the Server Members intent

client.on(Events.GuildMemberRemove, async (member: GuildMember | PartialGuildMember) => {
  try {
    await sendMessage(member.guild.channels.cache.get(config.channels.modLog), `${member.user?.tag ?? member.id} has left the server.`);
    // They're gone, so we no longer need anything about them (their opt-out choice is kept)
    db.removeUser(member.id);
    spamTracker.clear(member.id);
  } catch (error) {
    console.error('guildMemberRemove failed:', errMsg(error));
  }
});

client.on(Events.MessageDelete, async message => {
  try {
    if (!config.intents.messageContent) return;
    const author = message.author;
    if (!author || author.bot || !message.guild || message.content == null) return;
    if (db.isOptedOut(author.id)) return; // respect opt-outs: don't copy their deleted messages anywhere
    if (message.content.length >= 1900) return;

    await sendMessage(message.guild.channels.cache.get(config.channels.modLog), {
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
    if (!config.intents.guildMembers && message.type === MessageType.UserJoin) {
      const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
      if (member) await welcomeMember(member);
      return;
    }

    const owner = isOwner(message);

    // Keep #chunk-manipulation clean (owner-only channel)
    if (message.channel.id === config.channels.chunkManipulation && !owner) {
      await message.delete().catch(error => console.error('Error deleting message:', errMsg(error)));
      return;
    }

    if (message.author.bot || message.webhookId || message.system) return;

    // Only store per-user data when we can also delete it on leave (needs the Server Members intent)
    if (config.intents.guildMembers) db.recordMessage(message.author.id); // no-op for opted-out users

    if (!config.intents.messageContent) return; // everything below needs to read message text

    if (await checkForSpam(message, owner)) return;
    await checkForHelpRequest(message, owner);
  } catch (error) {
    console.error('messageCreate failed:', errMsg(error));
  }
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    await handleInteraction(interaction);
  } catch (error) {
    console.error('interactionCreate failed:', errMsg(error));
  }
});

/////////////////////////////////////////////////////////////////////////////
////////////////////////////// Message handling /////////////////////////////
/////////////////////////////////////////////////////////////////////////////
/** Returns true if the message was treated as spam (so nothing else should respond to it). */
async function checkForSpam(message: GuildMessage, owner: boolean): Promise<boolean> {
  if (isExempt(message, owner)) return false;
  const assessment = spamTracker.assess(message.author.id, message.channel.id, message.content, message);
  if (assessment.total < config.moderation.threshold) return false;

  const outcome = await actOnSpam(message, assessment);
  spamTracker.clear(message.author.id);
  if (outcome === 'banned' || outcome === 'kicked') db.removeUser(message.author.id);
  return true;
}

async function reply(message: GuildMessage, text: string, reason: string): Promise<void> {
  await sendMessage(message.channel, text);
  db.cdMetrics.botMessageCount++;
  db.markDirty();
  replyCounts.set(message.author.id, (replyCounts.get(message.author.id) ?? 0) + 1);
  console.log(`Sent reply #${db.cdMetrics.botMessageCount} (${reason})`);
}

async function checkForHelpRequest(message: GuildMessage, owner: boolean): Promise<void> {
  const content = message.content;
  let replied = false;

  if (!owner && await canReply(message, true)) {
    if (matchesHelpRequest(content)) {
      await reply(message, `Hey ${message.author}, please see <#${config.channels.archive}> for all world downloads and schematics.`, 'world download');
      replied = true;
    } else if (matchesFarmQuestion(content)) {
      await reply(
        message,
        `Hey ${message.author}, this server has many different tree farm designs by many different people.\n\n` +
        'Please include the name of the farm you need help with.',
        'tree farm'
      );
      replied = true;
    }
  }

  if (!replied && mentionsPaper(content) && (owner || await canReply(message, false))) {
    const now = Date.now();
    if (now - db.cdMetrics.lastPaperMsgTimestamp >= config.limits.paperCooldownMs) {
      db.cdMetrics.lastPaperMsgTimestamp = now;
      const timestamp = Math.random() < 0.1 ? 14 : 1128; // 1 in 10 chance for 14, otherwise 1128
      await reply(message, `[paper lol](<https://youtube.com/watch?v=XjjXYrMK4qw&t=${timestamp}s>)`, 'paper');
    }
  }
}

async function canReply(message: GuildMessage, restrictToHelpChannels: boolean): Promise<boolean> {
  if (db.rollHourIfNeeded()) replyCounts.clear();

  if (db.cdMetrics.botMessageCount >= config.limits.hourlyBotMessages) {
    if (!db.cdMetrics.botLimitReached) {
      console.log(`Reached hourly message limit (${db.cdMetrics.botMessageCount})`);
      db.cdMetrics.botLimitReached = true;
    }
    return false;
  }

  const userId = message.author.id;
  const count = replyCounts.get(userId) ?? 0;
  if (count >= config.limits.hourlyPerUserReplies) {
    if (count === config.limits.hourlyPerUserReplies) {
      await sendMessage(message.channel, `Hey ${message.author}, please relax your use of my features.`);
      replyCounts.set(userId, count + 1); // so the warning is only sent once
    }
    return false;
  }

  if (restrictToHelpChannels && !config.helpChannelIds.includes(message.channel.id)) return false;
  if (message.member?.roles.cache.some(role => config.exemptRoleNames.includes(role.name))) return false;
  return true;
}

/////////////////////////////////////////////////////////////////////////////
/////////////////////////// Housekeeping & lifecycle ////////////////////////
/////////////////////////////////////////////////////////////////////////////
async function runScheduledTasks(): Promise<void> {
  if (db.rollHourIfNeeded()) replyCounts.clear();
  spamTracker.prune();
  if (Date.now() - db.cdMetrics.lastBackupAt >= config.limits.backupIntervalMs) db.backup();
  db.save(); // only writes if something changed
}

async function announceStatus(color: `#${string}`, title: string, description: string): Promise<void> {
  const embed = new EmbedBuilder().setColor(color).setTitle(title).setDescription(description);
  await sendMessage(client.channels.cache.get(config.channels.welcome), { embeds: [embed] });
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, bot is closing...`);
  setTimeout(() => process.exit(1), 10_000).unref(); // never hang forever
  db.save(true);
  db.backup();
  await announceStatus('#E90022', '🤖 Bot Offline 🌳', 'Good luck w/o me :)');
  await client.destroy();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM')); // what systemd, docker and pm2 send
process.on('unhandledRejection', reason => console.error('Unhandled rejection:', reason));

const token = readSecret('DISCORD_TOKEN', 'token.txt');
if (!token) throw new Error('No bot token found. Set DISCORD_TOKEN or create src/token.txt.');

db.load(); // before login, so no event can arrive while the data isn't loaded
void client.login(token);
