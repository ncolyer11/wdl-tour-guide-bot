const Discord = require('discord.js');
const { EmbedBuilder } = require('discord.js');
const client = new Discord.Client({
  intents: [
    Discord.GatewayIntentBits.Guilds,
    Discord.GatewayIntentBits.GuildMembers,
    Discord.GatewayIntentBits.GuildMessages,
    Discord.GatewayIntentBits.MessageContent,
  ],
  disableMentions: 'everyone'
});

const { safeRoles, triggerPhrases, otherPhrases, excPhrases, welcomeMessages, channelIds } = require('./strings');
const path = require('path');
const fs = require('fs');
// @ts-ignore
const fetch = require('node-fetch');
const linkify = require('linkifyjs');
const util = require('util');

const HOURLY_MSG_LIMIT = 10;
const HOURLY_INDV_REPLY_LIMIT = 3;
const CHANNEL_COOLDOWN = 20000;
const APPROX_DISCORD_CHAR_LIMIT = 1900;
const SPAM_MESSAGE_LIMIT = 4;
const MAXRETRIES = 5;
const archiveChannel = '1019870085617291305';
const testingChannelId = '1094609234978668765';
const mathsAndCodeChannelId = '1036212683374088283'
const chunkManipulationChannelId = '930048455777325076';

interface UserReplyData {
  username: string;
  replyCount: number;
}

export interface User {
  name: string;
  userId: string;
  roles: string[];
  timeJoined: number;
  totalMessageCount: number;
  recentSusMessageCount: number; // Number of messages sent in the last 20 or so seconds
  channels: {
    [channelId: string]: number[];
  };
}

// Cooldown metrics
interface cdMetrics {
  botMessageCount: number;
  botLimitReached: boolean;
  currentHour: number;
  lastPaperMsgTimestamp: number;
  lastMessageIndex: number | undefined;
}

interface DataStore {
  cdMetrics: cdMetrics;
  latestStemlightReleaseTag: string;
  users: User[];
  userReplyData: UserReplyData[];
}

let dataStore: DataStore;

function getDefaultDataStore(): DataStore {
  return {
      cdMetrics: {
          botMessageCount: 0,
          botLimitReached: false,
          currentHour: new Date().getHours(),
          lastPaperMsgTimestamp: 0,
          lastMessageIndex: undefined
      },
      latestStemlightReleaseTag: '',
      users: [],
      userReplyData: []
  };
}

/////////////////////////////////////////////////////////////////////////////
//////////////////////////////// End Points /////////////////////////////////
/////////////////////////////////////////////////////////////////////////////
client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  sendBotOnlineMessage();
  await loadDatabase();

  // Run set tasks every 15 minutes
  setInterval(async () => {await runSetTasks()}, 1000 * 60 * 15);
});

// Event handler for when the bot is closed using Ctrl + C
process.on('SIGINT', async () => {
  await saveDatabase(); // Ensure the database is saved before closing
  await backupDatabase();
  await sendBotOfflineMessage();
  console.log('Bot is closing...');
  process.exit(0);
});

client.on('guildMemberAdd', async (member) => {
  let user: User = {
    name: member.user.username,
    userId: member.id,
    roles: member.roles.cache.map(role => role.name), // ensure it's an array of strings
    timeJoined: Date.now(),
    totalMessageCount: 0,
    recentSusMessageCount: 0,
    channels: {},
  };
  dataStore.users.push(user);

  // Define an array of integers representing the relative rarities of each welcome message
  const messageRarities = [7, 3, 3, 3, 1, 2, 3, 4, 4, 4, 3, 3, 6, 3, 1, 4, 2, 7, 7, 5, 2, 6,
                           7, 3, 4, 6, 5];

  let messageIndex: number = weightedRandomIndex(messageRarities);
  let lastMessageIndex = dataStore.cdMetrics.lastMessageIndex;
  if (typeof lastMessageIndex === 'undefined') {
    lastMessageIndex = messageIndex;
  }

  // Make sure the same welcome message isn't sent twice in a row
  while (messageIndex === lastMessageIndex) {
    messageIndex = weightedRandomIndex(messageRarities);
  }

  const message: string = welcomeMessages[messageIndex];
  const welcomeMessage: string = `${message}`
    .replace('{member}', `<@${member.id}>`)
    .replace('{archive}', `<#${archiveChannel}>`)
    .replace('{Froge}', `<:Froge:930083494938411018>`);
  await sendMessage(member.guild.systemChannel, welcomeMessage);

  dataStore.cdMetrics.lastMessageIndex = messageIndex;
  console.log(`Sent welcome message to ${member.user.tag}`);

  await dmUser(member);
});

client.on('guildMemberRemove', async (member) => {
  // Send a message in the 'bot-testing' channel when a member leaves the server
  const testingChannelId = '1094609234978668765';
  const testingChannel = member.guild.channels.cache.get(testingChannelId);

  if (testingChannel) {
    await sendMessage(testingChannel, `${member.user.tag} has left the server.`);
  }

  // Free up some much needed space now that we don't need them anymore
  dataStore.users = dataStore.users.filter(user => user.userId !== member.id);
});

client.on('messageDelete', async (message) => {
  if (message.author.bot || message.client.user.id === message.author.id) {
    return;
  }

  const testingChannel = message.guild.channels.cache.get(testingChannelId);
  if (testingChannel) {
    // If any mention found, replace them with text to avoid ping
    const sanitizedContent = message.content
      .replace(/@everyone/g, '`@everyone`')
      .replace(/@here/g, '`@here`');

    if (message.content.length < APPROX_DISCORD_CHAR_LIMIT) {
      await sendMessage(
        testingChannel,
        
        `**Deleted Message:** \n- User: *${message.author.username}*\n- Channel: ${message.channel}\n- Message: "${sanitizedContent}"`
      
      );
    }
    console.log('Message deleted');
  }
});

client.on('messageCreate', async (message) => {
  // Runs owner-specific commands prefixed with '!'
  const isOwner: boolean = await runIfOwnerCommand(message);

  // Prevent messages in this channel fsr
  cleanChunkManipulation(message, isOwner);
  
  // Return if the author a bot to not self-reply or reply to other bots
  if (message.author.bot) return;
  
  // Check for spam and ban user if required
  const didBan: boolean = await checkBan(message);

  // Skip if the user was banned when responding to commonly asked questions
  if (!didBan) checkUserMessageForResponse(message, isOwner);
});

// Periodically check for new Stemlight releases
client.once('ready', async () => {
  // Delay to give the bot time to start up
  await new Promise(res => setTimeout(res, 5000));
  console.log('Checking for new releases...');
  if (await checkForNewRelease()) {
    console.log(`New release found: ${dataStore.latestStemlightReleaseTag}`);
  } else {
    console.log('No new releases found.');
  }
  setInterval(checkForNewRelease, 15 * 60 * 1000); // Check every 15 minutes (in milliseconds)
});

/////////////////////////////////////////////////////////////////////////////
///////////////////////////////// Functions /////////////////////////////////
/////////////////////////////////////////////////////////////////////////////
function cleanChunkManipulation(message, isOwner): void {
  if (message.channel.id === chunkManipulationChannelId && !isOwner) {
    message.delete().catch(error => console.error('Error deleting message:', error));
    console.log("Kept #chunk-manipulation clean")
  }
}

async function loadDatabase(): Promise<void> {
  const databaseFilePath = path.join(__dirname, 'database.json');
  try {
    const data = fs.readFileSync(databaseFilePath, 'utf8');
    dataStore =  JSON.parse(data);
    console.log('Database loaded successfully');
  } catch (error: any) {
    console.error('Error loading database:', error.message.substring(0, 100));
    // If can't load from file :/ try loading from backup :?
    console.log('Attempting to load from backup...');
    const backedUpData: DataStore | false = await loadFromBackup();
    if (backedUpData) {
      dataStore =  backedUpData;
      console.log('Loaded from backup successfully');
    // If even the backup fails :[ start fresh :(((
    } else {
      dataStore =  getDefaultDataStore();
      console.log('Starting a fresh database');
    }
  }
}

// Runs server tasks every 15 minutes
async function runSetTasks(): Promise<void> {
  pruneDatabase();

  // Save every 15 minutes
  await saveDatabase()
  // Backup the database every 12 hours
  if (new Date().getHours() % 12 === 0) {
    await backupDatabase();
  }
}

// Deletes users from database who have no data
function pruneDatabase(): void {
  dataStore.users = dataStore.users.filter(user => user.totalMessageCount > 0);
  // sorts .users by total messages
  dataStore.users.sort((a, b) => b.totalMessageCount - a.totalMessageCount);
}

async function saveDatabase(): Promise<void> {
  // If an hour has passed, reset the bot's cooldown metrics and update the current hour
  updateHourlyLimit();
  const databaseFilePath = path.join(__dirname, 'database.json');
  try {
    fs.writeFileSync(databaseFilePath, JSON.stringify(dataStore, null, 2), 'utf8');
    console.log('Database saved successfully');
  } catch (error: any) {
    console.error('Error saving database:', error.message.substring(0, 100));
  }
}

// Backup the database to a separate file for redundancy
async function backupDatabase(): Promise<boolean> {
  const backupFilePath = path.join(__dirname, 'database_backup.json');
  try {
    await saveDatabase();
    fs.writeFileSync(backupFilePath, JSON.stringify(dataStore, null, 2), 'utf8');
    console.log('Database backed up successfully');
    return true;
  } catch (error: any) {
    console.error('Error backing up database:', error.message.substring(0, 100));
    return false;
  }
}

async function loadFromBackup(): Promise<DataStore | false> {
  const backupFilePath = path.join(__dirname, 'database_backup.json');
  try {
    const data = fs.readFileSync(backupFilePath, 'utf8');
    dataStore = JSON.parse(data);
    console.log('Backup loaded successfully');
    // Retstore datastore to backup by updating the dataBase with the new dataStore
    await saveDatabase();
    return dataStore;
  } catch (error: any) {
    console.error('Error loading backup:', error.message.substring(0, 100));
    return false;
  }
}

function weightedRandomIndex(weights): number {
  let totalWeight = weights.reduce((acc, w) => acc + w);
  let random = Math.random() * totalWeight;
  for (let i = 0; i < weights.length; i++) {
    random -= weights[i];
    if (random < 0) {
      return i;
    }
  }
  return 0;
}

// Checks a user's message for trigger phrases and responds accordingly
async function checkUserMessageForResponse(message, isOwner): Promise<void> {
  let botMessageCount = dataStore.cdMetrics.botMessageCount;
  // Only check for trigger phrases in the specified channels
  let channelRestrict: boolean = true;
  let botReplied: boolean = false;
  if (isOwner || await canSendMessage(message, channelRestrict)) {
    if (triggerPhrases.some(phrase => message.content
        .toLowerCase()
        .replace(/['",.\-`()]/g, '')
        .includes(phrase)
      )) {
      message.channel.send(`Hey ${message.author}, please see <#${archiveChannel}> for all world downloads and schematics.`);
      console.log(`Sent message ${botMessageCount} in response to "world download"`);
      incrementUserReplyCount(message.author.username);
      botMessageCount++;
      botReplied = true;

    } else if (otherPhrases.some(phrase => message.content.toLowerCase().includes(phrase))
        && !excPhrases.some(phrase => new RegExp('\\b' + phrase + '\\b', 'i').test(message.content))) {
      message.channel.send(
        `Hey ${message.author}, this server has many different tree farm designs by many different people.\n\nPlease include the name of the farm you need help with.`
      );
      console.log(`Sent message ${botMessageCount} in response to "tree farm"`);
      incrementUserReplyCount(message.author.username);
      botMessageCount++;
      botReplied = true;
    }
  }
  
  channelRestrict = false;
  if (!botReplied && (isOwner || await canSendMessage(message, channelRestrict))) {
    if (message.content.toLowerCase().includes('paper')) {
      console.log("Paper devs being tarts");
      const now = Date.now();
      if (now - dataStore.cdMetrics.lastPaperMsgTimestamp >= 60 * 1000) { // 1 minute cooldown
        // Randomly decide the timestamp
        const timestamp = Math.random() < 0.1 ? 14 : 1128; // 1 in 10 chance for 14, 9 in 10 chance for 1128
  
        message.channel.send(`[paper lol](<https://youtube.com/watch?v=XjjXYrMK4qw&t=${timestamp}s>)`);
        console.log('Sent message in response to paper devs being tarts');
        incrementUserReplyCount(message.author.username);
        botMessageCount++;
        botReplied = true;
        dataStore.cdMetrics.lastPaperMsgTimestamp = now; // update the last message timestamp
      }
    }
  }

  dataStore.cdMetrics.botMessageCount = botMessageCount;
}

async function runIfOwnerCommand(message): Promise<boolean> {
  if (!message.member) {
    console.error('Message is not from a guild or member context is null.');
    // Account is exploiting discord and needs to be banned, or if that fails, kicked
    try {
          await banUser(message.guild, message.author, message.channel, message.content);
    } catch (error) {
          try {
              await banUser(message.guild, message.author, message.channel, message.content, true);
          } catch (innerError) {
              return false;
          }
    }

    return false;
  }

  const hasOwnerRole = message.member.roles.cache.some(
    role => role.name === 'slightly different shade of cyan'
  );
  // Return false if not owner
  if (!(hasOwnerRole || message.author.username === 'ncolyer')) {
    return false;
  }
  const msg = message.content;
  if (msg.startsWith('!prune')) {
    pruneMessages(message);
  } else if (message.content.startsWith('!data')) {
    console.log(util.inspect(dataStore, { depth: null, colors: true }));
    saveDatabase();
    message.reply('Server data saved and printed to console.');
  } else if (message.content.startsWith('!backup')) {
    const backedUp = await backupDatabase();
    if (backedUp) {
      message.reply('Server data successfully backed up.');
    } else {
      message.reply('Error backing up server data.');
    }
  } else if (message.content.startsWith('!reload')) {
    await loadDatabase();
    message.reply('Server data reloaded.');
  }

  return true;
}

async function dmUser(member): Promise<void> {
  const prefix = `https://discord.com/channels/930027805398429736/`;
  const dmMessage = `Hi, thanks for joining <:warped_fungus:1264941277779333242> Huge Fungi Huggers <:crimson_fungus:1264941397056819321>!
  
Here are some shortcuts to help you on your nether tree farming journey:
 <:warped_stem:1264941326621999215>  [**12 Type Tree Farm Download**](${prefix}1221071923803586560)
 <:crimson_stem:1264941385673605150>  [**Simple & Rapid Nether Tree Farm Download**](${prefix}1096118419201462303)
 <:shroomlight:1264941341129834528>  [**All Farm World Downloads & Schematics**](${prefix}1019870085617291305)`;
  try {
    await member.send(dmMessage);
    console.log(`Sent DM to ${member.user.tag}`);
  } catch (error) {
    console.error(`Error sending DM to ${member.user.tag}. User likely doesn't accept DMs.`);
  }
}

async function sendMessage(channel, content): Promise<boolean> {
  try {
    await channel.send(content);
    return true;
  } catch (error) {
    console.error('Error sending message:', content.substring(0, 30), '\nError: ', error);
    return false;
  }
}

async function canSendMessage(message, channelRestrict) {
  // Check if the message count has reached the limit

  if (dataStore.cdMetrics.botMessageCount >= HOURLY_MSG_LIMIT) {
    if (!dataStore.cdMetrics.botLimitReached) {
      console.log(`Reached message limit at message count: ${dataStore.cdMetrics.botMessageCount}`);
      dataStore.cdMetrics.botLimitReached = true;
    }
    return false;
  }

  const user: UserReplyData | undefined = dataStore.userReplyData.find(
    user => user.username === message.author.username);
  if (user && user.replyCount >= HOURLY_INDV_REPLY_LIMIT) {
    if (user.replyCount == HOURLY_INDV_REPLY_LIMIT) { 
      await sendMessage(message.channel, `Hey ${message.author}, please relax your use of my features.`);
      incrementUserReplyCount(message.author.username);
    }
    console.log(
      `Individual user reply limit reached for user: ${message.author.username} after ${user.replyCount} replies`
    )
    return false;
  }

  // Check if the message was sent in one of the specified channels
  if (channelRestrict && !channelIds.includes(message.channel.id)) {
    // console.log('Invalid channel');
    return false;
  }

  // Check if the member has any of the restricted roles
  if (message.member && 
      message.member.roles.cache.some(role => safeRoles.includes(role.name))) {
    // console.log('Member has restricted role');
    return false;
  }

  // All checks passed
  return true;
}

// Reset message count and update current hour
function updateHourlyLimit() {
  const newHour = new Date().getHours();
  if (newHour !== dataStore.cdMetrics.currentHour) {
    dataStore.cdMetrics.currentHour = newHour;
    dataStore.cdMetrics.botMessageCount = 0;
    dataStore.userReplyData = [];
    dataStore.cdMetrics.botLimitReached = false;
  }
}

////////////////////////////////////////
////////// BAN USER FUNCTIONS //////////
////////////////////////////////////////
async function checkBan(message): Promise<boolean> {
  const { author, guild, channel } = message;
  updateUserMessages(channel.id, message);
  
  const user = dataStore.users.find(user => user.userId === author.id);
  // Check for ban conditions
  if (user && user.recentSusMessageCount >= SPAM_MESSAGE_LIMIT){
    await banUser(guild, author, channel, message.content);
  }

  return false;
}

// Function to update user's message timestamps
function updateUserMessages(channelId, message) {
  const { author } = message;
  const userId = author.id;
  let roles = message.member.roles.cache
  // Convert list of role objects to list of role names
  roles = roles.map(role => role.name);
  let user: User | undefined = dataStore.users.find(user => user.userId === userId);
  
  // In case somehow the userId changed since the user was added to dataStore
  if (!user) {
    user = {
      name: author.username,
      userId,
      roles,
      timeJoined: Date.now(),
      totalMessageCount: 0,
      recentSusMessageCount: 0,
      channels: {},
    };
    dataStore.users.push(user);
  }

  user.totalMessageCount++; // Increment total message count
  
  const links = linkify.find(message.content);
  // Update user's message timestamps
  const keywords = [
    '@everyone', '@here', 'steam', 'discord', 'discord nitro', 'free nitro', 'free gift',
    'free giveaway', 'free money', 'hack', 'bitcoin', 'crypto'
  ];
  const isSuspicious = keywords.some(keyword => message.content.includes(keyword));
  
    
  // Remove timestamps older than CHANNEL_COOLDOWN
  for (channelId in user.channels) {
    if (user.channels.hasOwnProperty(channelId)) {
      const freshMessages = user.channels[channelId].filter(
        time => Date.now() - time < CHANNEL_COOLDOWN
      );

      user.recentSusMessageCount -= (user.channels[channelId].length - freshMessages.length);
      user.channels[channelId] = freshMessages;
    }
  }

  if (links.length > 0 && isSuspicious) {
    // If first time spamming in this channel
    if (!user.channels[channelId]) user.channels[channelId] = [];
      user.channels[channelId].push(Date.now());
      user.recentSusMessageCount++;
    // Debug dataStore
    // console.log(util.inspect(dataStore, { depth: null, colors: true }));
  }
}

// Bans user and logs details to bot log channel
async function banUser(guild, user, channel, messageContent, kick=false) {
  const member = await guild.members.fetch(user);
  if (member) {
    // Ban and delete the scammer's messages
    if (kick) {
      await member.kick('Bot detected violation of rules');
      console.log(`Kicked member: ${user.username}`);
    } else {
      await member.ban({
        deleteMessageSeconds: 60 * 60 * 24 * 7,
        reason: 'Bot detected violation of rules'
      });
      sendBanMessage(user, channel);
      console.log(`Banned member: ${user.username}`);
    }

    const testingChannel = guild.channels.cache.get(testingChannelId);
    if (testingChannel) {
      const sanitizedContent = messageContent
        .replace(/@everyone/g, '`@everyone`')
        .replace(/@here/g, '`@here`');
      
      await sendMessage(
        testingChannel,
        `**Deleted Message:** \n- Banned User: *${user.username}*\n- Channel: ${channel.name}\n- Message: "${sanitizedContent}"`
      );
    }
  }
}

// Send a message when the bot auto bans a scammer
async function sendBanMessage(user, channel) {
  const embedMessage = new EmbedBuilder()
    .setColor('#111111')
    .setTitle(`🔨 Banned User: ${user.username} 🚫`)
    .setDescription('Looks like they won\'t be spamming any longer');
  
  await sendMessage(channel, { embeds: [embedMessage] });
}

// Send a message when the bot is started
async function sendBotOnlineMessage() {
  const embedMessage = new EmbedBuilder()
    .setColor('#00CCEE')
    .setTitle('🤖 Bot Online ⚡')
    .setDescription('Ready to give some wdl tours! 🚀');

  const welcomeChannel = client.channels.cache.get(channelIds[2]);
  if (welcomeChannel) {
    await sendMessage(welcomeChannel, { embeds: [embedMessage] });
  }
}

// Send a message when the bot is closed
async function sendBotOfflineMessage() {
  const embedMessage = new EmbedBuilder()
    .setColor('#E90022')
    .setTitle('🤖 Bot Offline 🌳')
    .setDescription('Good luck w/o me :)');

  const welcomeChannel = client.channels.cache.get(channelIds[2]);
  if (welcomeChannel) {
    await sendMessage(welcomeChannel, { embeds: [embedMessage] });
  }
}

// Mass delete new messages
async function pruneMessages(message) {
  // Extract the number of messages to prune
  const args = message.content.split(' ');
  let numMessages = parseInt(args[1]);

  // Validate the number of messages
  if (isNaN(numMessages)) {
    message.reply('Alright since you didn\'t specify a number, I\'ll just prune the last message.\nType `confirm` to proceed.');
    numMessages = 1;
  } else if (numMessages < 1 || numMessages > 50) {
    message.reply('Please specify a number between 1 and 50 and try again.');
    return;
  } else {
    await sendMessage(
      message.channel,
      `Are you sure you want to prune the last ${numMessages} messages? Type \`confirm\` to proceed.`
    );
  }

  
  // Wait for confirmation from the user
  const filter = m => m.author.id === message.author.id && m.content.toLowerCase() === 'confirm';
  let confMsg;
  let didBulkDelete = false;
  try {
    // Wait 7 seconds for a response, otherwise cancel the bulk delete
    await message.channel.awaitMessages({ filter, max: 1, time: 7 * 1000, errors: ['time'] })
    .then(async collected => {
      // Prune the messages
      const messages = await message.channel.messages.fetch({ limit: numMessages + 3 });
      await message.channel.bulkDelete(messages.size);
      didBulkDelete = true;
    })
    .catch(() => {
      message.reply('Confirmation timed out. Operation canceled.');
    });
  } catch (error) {
    console.log(`Error Bulk Deleting Messages: ${error}`);
  }
  
  if (!didBulkDelete) return;

  try {
    if (numMessages === 1) {
      confMsg = await message.channel.send(`✅ Successfully pruned the last message ✂`);
    } else {
      confMsg = await message.channel.send(`✅ Successfully pruned the last ${numMessages} messages ✂`);
    }
  } catch (error) {
    console.log(`Error Sending Prune ConfirmationV2 Message: ${error}`);
    confMsg = false;
  }

  // Delete the 2nd confirmation message after 5 seconds
  if (confMsg) {
    setTimeout(() => {
      confMsg.delete().catch(error => console.error('Error deleting confirmation message:', error));
    }, 5000);
  }
}

// Check for new releases of Stemlight and post them to #maths-and-code
async function checkForNewRelease(): Promise<boolean> {
  const retryDelay = 5000; // Initial retry delay (5 seconds)

  for (let attempt = 1; attempt <= MAXRETRIES; attempt++) {
    try {
      const repo = 'ncolyer11/Stemlight';
      const url = `https://api.github.com/repos/${repo}/releases/latest`;
      const personalAccessTokenPath = path.join(__dirname, 'PAT.txt');
      const personalAccessToken = fs.readFileSync(personalAccessTokenPath, 'utf8').trim();

      const response = await fetch(url, {
        headers: {
          Authorization: `token ${personalAccessToken}`,
          'User-Agent': 'World Download Bot'
        }
      });

      if (!response.ok) {
        // Handle rate limiting
        if (response.status === 403 && response.headers.get('X-RateLimit-Remaining') === '0') {
          const resetTimeHeader = response.headers.get('X-RateLimit-Reset');
          if (resetTimeHeader) {
            const resetTime = parseInt(resetTimeHeader, 10) * 1000;
            const waitTime = resetTime - Date.now();
            console.log(`Rate limit exceeded. Retrying in ${Math.ceil(waitTime / 1000)} seconds...`);
            await new Promise(res => setTimeout(res, waitTime));
            continue;
          } else {
            console.error('X-RateLimit-Reset header not found. Cannot determine wait time.');
            break;
          }
        }
        throw new Error(`GitHub API responded with status ${response.status}`);
      }

      const data = await response.json();

      if (data.tag_name !== getLastReleaseTag()) {
        const channel = client.channels.cache.get(mathsAndCodeChannelId);
        if (channel) {
          const embed = new EmbedBuilder()
            .setColor('#00a7a3')
            .setTitle(`New Stemlight Release: ${data.tag_name}`)
            .setDescription(data.body)
            .setURL(data.html_url);

          const imageUrls = extractImageUrls(data.body);
          let embeds = [embed];
          imageUrls.forEach(url => {
            const fileEmbed = new EmbedBuilder().setImage(url);
            embeds.push(fileEmbed);
            embed.setDescription(embed.data.description.replace(new RegExp(`\\!\\[.*?\\]\\(${url}\\)`, 'g'), '  - *see attached image*'));
          });
          
          await sendMessage(channel, { embeds });
        }
        updateLastReleaseTag(data.tag_name);
        return true;
      }

    } catch (error) {
      const err = error as Error;
      console.error(`Attempt ${attempt} failed: ${err.message}`);
      if (attempt < MAXRETRIES) {
        const backoffDelay = retryDelay * attempt; // Exponential backoff
        console.log(`Retrying in ${backoffDelay / 1000} seconds...`);
        await new Promise(res => setTimeout(res, backoffDelay));
      } else {
        console.error('Max retries reached. Giving up.');
      }
    }
  }

  return false;
}

// Retrieve the last known release tag from a file
function getLastReleaseTag() {
  // Keep loose backwards compatibility for now
  const useDataBase: boolean = true;
  if (useDataBase) {
    return dataStore.latestStemlightReleaseTag;
  }
  const filePath = path.join(__dirname, 'last_release.txt');
  try {
      // Read the content of the file
      const tag = fs.readFileSync(filePath, 'utf8');
      return tag.trim();
  } catch (error) {
      console.error('Error reading last release tag:', error);
      return null;
  }
}

// Update the last known release tag in a file
function updateLastReleaseTag(tag) {
  // Keep loose backwards compatibility for now
  const useDataBase: boolean = true;
  if (useDataBase) {
    dataStore.latestStemlightReleaseTag = tag;
    return;
  }
  const filePath = path.join(__dirname, 'last_release.txt');
  try {
      // Write the tag to the file
      fs.writeFileSync(filePath, tag, 'utf8');
      console.log('Last release tag updated:', tag);
  } catch (error) {
      console.error('Error updating last release tag:', error);
  }
}

// Extracts image URLs from release notes
function extractImageUrls(releaseNotes) {
  const regex = /\!\[.*?\]\((.*?)\)/g; // Regex to match the markdown image syntax and extract the URL
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(releaseNotes)) !== null) {
      matches.push(match[1] as string); // Extract the URL from the matched markdown syntax and add it to the array
  }

  return matches;
}

function incrementUserReplyCount(username) {
  const index = dataStore.userReplyData.findIndex(user => user.username === username);
  if (index !== -1) {
    dataStore.userReplyData[index].replyCount++;
  } else {
    dataStore.userReplyData.push({ username, replyCount: 1 });
  }
}

// Login
const tokenFilePath = path.join(__dirname, 'token.txt');
const token = fs.readFileSync(tokenFilePath, 'utf8').trim();
client.login(token);
