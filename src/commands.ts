import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  ComponentType,
  Interaction,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from './config';
import { db } from './database';
import { buildShortcutsText } from './strings';
import { errMsg, isOwnerUserId } from './utils';

/////////////////////////////////////////////////////////////////////////////
////////////////////////////// Definitions //////////////////////////////////
/////////////////////////////////////////////////////////////////////////////
const privacyCommand = new SlashCommandBuilder()
  .setName('privacy')
  .setDescription('See or control the data this bot stores about you')
  .addSubcommand(s => s.setName('info').setDescription('What this bot stores, why, and for how long'))
  .addSubcommand(s => s.setName('mydata').setDescription('Show exactly what is stored about you'))
  .addSubcommand(s => s.setName('optout').setDescription('Stop storing data about you and delete what exists'))
  .addSubcommand(s => s.setName('optin').setDescription('Allow the bot to store basic activity data about you again'));

const downloadsCommand = new SlashCommandBuilder()
  .setName('downloads')
  .setDescription('Get the links to the world downloads and schematics')
  .setContexts(InteractionContextType.Guild);

const adminCommand = new SlashCommandBuilder()
  .setName('admin')
  .setDescription('Owner-only maintenance')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages) // hides it from regular members
  .setContexts(InteractionContextType.Guild)
  .addSubcommand(s =>
    s.setName('prune').setDescription('Bulk delete recent messages in this channel')
      .addIntegerOption(o => o.setName('count').setDescription('How many (1-50)').setMinValue(1).setMaxValue(50).setRequired(true)))
  .addSubcommand(s => s.setName('stats').setDescription('Show bot status'))
  .addSubcommand(s => s.setName('backup').setDescription('Save and back up the database now'))
  .addSubcommand(s => s.setName('reload').setDescription('Reload the database from disk'));

export const commandDefinitions = [privacyCommand, downloadsCommand, adminCommand].map(c => c.toJSON());

/////////////////////////////////////////////////////////////////////////////
/////////////////////////////// Dispatcher //////////////////////////////////
/////////////////////////////////////////////////////////////////////////////
export async function handleInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  switch (interaction.commandName) {
  case 'privacy': return handlePrivacy(interaction);
  case 'downloads': return handleDownloads(interaction);
  case 'admin': return handleAdmin(interaction);
  }
}

const ephemeral = (content: string) => ({ content, flags: MessageFlags.Ephemeral } as const);

/////////////////////////////////////////////////////////////////////////////
////////////////////////////////// /privacy /////////////////////////////////
/////////////////////////////////////////////////////////////////////////////
const PRIVACY_INFO = [
  '**What this bot stores (encrypted at rest with AES-256-GCM):**',
  '• Your Discord user ID, when it first saw you, and how many messages you have sent.',
  '',
  '**What it does NOT store:** message content, usernames, roles, or anything about DMs.',
  '',
  '**Short-lived, memory-only (lost on restart):** timestamps used for scam detection (about 30 seconds) ' +
    'and reply rate limits (1 hour). These keep running even if you opt out, so the anti-scam filter ' +
    'cannot be dodged, but nothing about them is saved.',
  '',
  '**Moderator log:** when someone deletes a message, or the bot flags a scam, a copy goes to the moderators\' ' +
    'log channel. Opted-out users are excluded from the deleted-message log.',
  '',
  '**Retention:** your record is deleted when you leave the server, when you opt out, or when you are banned.',
  '',
  'Use `/privacy mydata` to see your record, `/privacy optout` to stop storage and delete it, ' +
    'or `/privacy optin` to allow it again.',
].join('\n');

async function handlePrivacy(interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;
  switch (interaction.options.getSubcommand()) {
  case 'info':
    return void await interaction.reply(ephemeral(PRIVACY_INFO));
  case 'mydata': {
    const record = db.getUser(userId);
    const content = db.isOptedOut(userId)
      ? 'You have **opted out**. Nothing is stored about you except that opt-out choice.'
      : record
        ? `Stored about you:\n\`\`\`json\n${JSON.stringify({
          userId: record.userId,
          firstSeen: new Date(record.firstSeen).toISOString(),
          totalMessageCount: record.totalMessageCount,
        }, null, 2)}\n\`\`\``
        : 'Nothing is stored about you right now.';
    return void await interaction.reply(ephemeral(content));
  }
  case 'optout':
    db.setOptOut(userId, true);
    return void await interaction.reply(ephemeral('Done. Your stored data has been deleted and nothing further will be stored about you.'));
  case 'optin':
    db.setOptOut(userId, false);
    return void await interaction.reply(ephemeral('Done. The bot may store basic activity data about you again. See `/privacy info` for details.'));
  }
}

/////////////////////////////////////////////////////////////////////////////
//////////////////////////////// /downloads /////////////////////////////////
/////////////////////////////////////////////////////////////////////////////
async function handleDownloads(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({
    content: `Here are the shortcuts, ${interaction.user}:\n${buildShortcutsText()}\n\nEverything else is in <#${config.channels.archive}>.`,
    allowedMentions: { users: [interaction.user.id] },
  });
}

/////////////////////////////////////////////////////////////////////////////
////////////////////////////////// /admin ///////////////////////////////////
/////////////////////////////////////////////////////////////////////////////
async function handleAdmin(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isOwnerUserId(interaction.user.id)) {
    return void await interaction.reply(ephemeral('Only the bot owner can use this.'));
  }

  switch (interaction.options.getSubcommand()) {
  case 'prune':
    return pruneMessages(interaction, interaction.options.getInteger('count', true));
  case 'stats': {
    const { users, optedOut } = db.stats();
    const intents = config.intents;
    return void await interaction.reply(ephemeral([
      `**Stored users:** ${users} (opted out: ${optedOut})`,
      `**Bot replies this hour:** ${db.cdMetrics.botMessageCount}/${config.limits.hourlyBotMessages}`,
      `**Latest Stemlight release:** ${db.latestStemlightReleaseTag || 'unknown'}`,
      `**Intents:** message content ${intents.messageContent ? 'on' : 'off'}, server members ${intents.guildMembers ? 'on' : 'off'}`,
    ].join('\n')));
  }
  case 'backup': {
    db.save(true);
    return void await interaction.reply(ephemeral(db.backup() ? 'Server data saved and backed up.' : 'Error backing up server data.'));
  }
  case 'reload':
    db.load();
    return void await interaction.reply(ephemeral('Server data reloaded.'));
  }
}

/** Bulk delete with a Confirm/Cancel button (buttons need no message-content intent). */
async function pruneMessages(interaction: ChatInputCommandInteraction, count: number): Promise<void> {
  const channel = interaction.channel;
  if (!channel || !('bulkDelete' in channel)) {
    return void await interaction.reply(ephemeral("I can't bulk delete in this kind of channel."));
  }

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('prune-confirm').setLabel(`Delete ${count}`).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('prune-cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  );
  const prompt = await interaction.reply({
    content: `Delete the last ${count} message${count === 1 ? '' : 's'} in this channel?`,
    components: [buttons],
    flags: MessageFlags.Ephemeral,
    withResponse: true,
  });

  try {
    const press = await prompt.resource!.message!.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: i => i.user.id === interaction.user.id,
      time: 15_000,
    });
    if (press.customId !== 'prune-confirm') {
      return void await press.update({ content: 'Cancelled.', components: [] });
    }
    await press.update({ content: 'Deleting…', components: [] });
    const deleted = await channel.bulkDelete(count, true); // true = skip messages older than 14 days instead of throwing
    await interaction.editReply(`✅ Pruned ${deleted.size} message${deleted.size === 1 ? '' : 's'} ✂`);
  } catch (error) {
    // awaitMessageComponent rejects on timeout; bulkDelete can reject on permissions
    await interaction.editReply({ content: `Prune cancelled: ${errMsg(error)}`, components: [] }).catch(() => undefined);
  }
}
