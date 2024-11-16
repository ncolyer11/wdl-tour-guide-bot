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

interface UserReplyData {
  username: string;
  replyCount: number;
}

export interface User {
  name: string;
  userId: string;
  role: string;
  timeJoined: number;
  totalMessageCount: number;
  recentMessageCount: number; // Number of messages sent in the last 20 or so seconds
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
  userReplyData: UserReplyData[];
  users: User[];
  cdMetrics: cdMetrics;
}

const dataStore: DataStore = {
  userReplyData: [],
  users: [],
  cdMetrics: {
    botMessageCount: 0,
    botLimitReached: false,
    currentHour: new Date().getHours(),
    lastPaperMsgTimestamp: 0,
    lastMessageIndex: undefined
  }
};

// Set interval to update hourly limit every hour
setInterval(updateHourlyLimit, 1000 * 60 * 60);

/////////////////////////////////////////////////////////////////////////////
//////////////////////////////// End Points /////////////////////////////////
/////////////////////////////////////////////////////////////////////////////
client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  sendBotOnlineMessage();
});

// Event handler for when the bot is closed using Ctrl + C
process.on('SIGINT', async () => {
  await sendBotOfflineMessage();
  console.log('Bot is closing...');
  process.exit(0);
});

client.on('guildMemberAdd', async (member) => {
  let user: User = {
    name: member.user.username,
    userId: member.id,
    role: member.roles.highest.name,
    timeJoined: Date.now(),
    totalMessageCount: 0,
    recentMessageCount: 0,
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
  member.guild.systemChannel.send(welcomeMessage);

  dataStore.cdMetrics.lastMessageIndex = messageIndex;
  console.log(`Sent welcome message to ${member.user.tag}`);

  await dmUser(member);
});

client.on('guildMemberRemove', (member) => {
  // Send a message in the 'bot-testing' channel when a member leaves the server
  const testingChannelId = '1094609234978668765';
  const testingChannel = member.guild.channels.cache.get(testingChannelId);

  if (testingChannel) {
    testingChannel.send(`${member.user.tag} has left the server.`);
  }
});

client.on('messageDelete', (message) => {
  if (message.author.bot || message.client.user.id === message.author.id) {
    return;
  }

  const testingChannel = message.guild.channels.cache.get(testingChannelId);
  if (testingChannel) {
    // If any mention found, replace them with text to avoid ping
    const sanitizedContent = message.content
      .replace(/@everyone/g, '`@everyone`')
      .replace(/@here/g, '`@here`');
    console.log(message)

    if (message.content.length < APPROX_DISCORD_CHAR_LIMIT) {
      testingChannel.send(
        `**Deleted Message:** \n- User: *${message.author.username}*\n- Channel: ${message.channel}\n- Message: "${sanitizedContent}"`
      );
    }
    console.log('Message deleted');
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return; // Check if the author is a bot
  updateHourlyLimit();

  // Server owner commands
  if (message.content.startsWith('!prune')) {
    pruneMessages(message);
  } else if (message.content.startsWith('!data')) {
    if (message.member.roles.cache.some(role => role.name === 'slightly different shade of cyan')) {
      console.log(util.inspect(dataStore, { depth: null, colors: true }));
      message.reply('Server data printed to console.');
    }
  }

  const chunkManipulationChannelId = '930048455777325076';
  if (message.channel.id === chunkManipulationChannelId) {
    message.delete().catch(error => console.error('Error deleting message:', error));
    console.log("Kept #chunk-manipulation clean")
  }

  checkBan(message);
  let botMessageCount = dataStore.cdMetrics.botMessageCount;
  if (canSendMessage(message, true)) {
    if (triggerPhrases.some(phrase => message.content
                              .toLowerCase()
                              .replace(/['",.\-`()]/g, '')
                              .includes(phrase)
      )) {
      message.channel.send(`Hey ${message.author}, please see <#${archiveChannel}> for all world downloads and schematics.`);
      console.log(`Sent message ${botMessageCount} in response to "world download"`);
      incrementUserReplyCount(message.author.username);
      botMessageCount++;
    } else if (otherPhrases.some(phrase => message.content.toLowerCase().includes(phrase))
               && !excPhrases.some(
      phrase => new RegExp('\\b' + phrase + '\\b', 'i').test(message.content))) {
        message.channel.send(
          `Hey ${message.author}, this server has many different tree farm designs by many different people.\n\nPlease include the name of the farm you need help with.`
        );
        console.log(`Sent message ${botMessageCount} in response to "tree farm"`);
        incrementUserReplyCount(message.author.username);
        botMessageCount++;
      }
    }
    
  if (canSendMessage(message, false)) {
    if (message.content.toLowerCase().includes('paper')) {
  
      const now = Date.now();
      if (now - dataStore.cdMetrics.lastPaperMsgTimestamp >= 60 * 1000) { // 1 minute cooldown
        // Randomly decide the timestamp
        const timestamp = Math.random() < 0.1 ? 14 : 1128; // 1 in 10 chance for 14, 9 in 10 chance for 1128
  
        message.channel.send(`[paper lol](<https://youtube.com/watch?v=XjjXYrMK4qw&t=${timestamp}s>)`);
        console.log('Sent message in response to paper devs being tarts');
        incrementUserReplyCount(message.author.username);
        botMessageCount++;
        dataStore.cdMetrics.lastPaperMsgTimestamp = now; // update the last message timestamp
      }
    }
  }
  dataStore.cdMetrics.botMessageCount = botMessageCount;
});

// Periodically check for new Stemlight releases
client.once('ready', () => {
  console.log('Checking for new releases...');
  setInterval(checkForNewRelease, 15 * 60 * 1000); // Check every 15 minutes (in milliseconds)
});

/////////////////////////////////////////////////////////////////////////////
///////////////////////////////// Functions /////////////////////////////////
/////////////////////////////////////////////////////////////////////////////
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
    console.error(`Error sending DM to ${member.user.tag}:`, error);
  }
}

function canSendMessage(message, channelRestrict) {
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
      message.channel.send(`Hey ${message.author}, please relax your use of my features.`);
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
async function checkBan(message) {
  const { author, guild, channel } = message;
  let users = dataStore.users;
  updateUserMessages(users, channel.id, message);
  
  const user = users.find(user => user.userId === author.id);
  // Check for ban conditions
  if (user && user.recentMessageCount >= SPAM_MESSAGE_LIMIT){
    await banUser(guild, author, channel, message.content);
    return;
  }
}

// Function to update user's message timestamps
function updateUserMessages(users, channelId, message) {
  const { author } = message;
  const userId = author.id;
  const role = author.roles.highest.name;
  let user = users.find(user => user.userId === userId);
  
  // In case somehow the userId changed since the user was added to dataStore
  if (!user) {
    user = {
      name: author.username,
      userId,
      role,
      timeJoined: Date.now(),
      totalMessageCount: 0,
      recentMessageCount: 0,
      channels: {},
    };
    users.push(user);
  }

  user.latestMessageTimestamp = Date.now(); // Update latest message timestamp
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

      user.recentMessageCount -= (user.channels[channelId].length - freshMessages.length);
      user.channels[channelId] = freshMessages;
    }
  }

  if (links.length > 0 && isSuspicious) {
    // If first time spamming in this channel
    if (!user.channels[channelId]) user.channels[channelId] = [];
    user.channels[channelId].push(Date.now());
    user.recentMessageCount++;
    // Debug dataStore
    console.log(util.inspect(dataStore, { depth: null, colors: true }));
  }
}

// Bans user and logs details to bot log channel
async function banUser(guild, user, channel, messageContent) {
  const member = await guild.members.fetch(user);
  if (member) {
    // Ban and delete the scammer's messages
    await member.ban({
      deleteMessageSeconds: 60 * 60 * 24 * 7,
      reason: 'Bot detected violation of rules'
    });
    sendBanMessage(user, channel);
    console.log(`Banned member: ${user.username}`);

    const testingChannel = guild.channels.cache.get(testingChannelId);
    if (testingChannel) {
      const sanitizedContent = messageContent
        .replace(/@everyone/g, '`@everyone`')
        .replace(/@here/g, '`@here`');
      testingChannel.send(
        `**Deleted Message:** \n- Banned User: *${user.username}*\n- Channel: ${channel.name}\n- Message: "${sanitizedContent}"`
      );
    }
  }
}

// Send a message when the bot auto bans a scammer
function sendBanMessage(user, channel) {
  const embedMessage = new EmbedBuilder()
    .setColor('#111111')
    .setTitle(`🔨 Banned User: ${user.username} 🚫`)
    .setDescription('Looks like they won\'t be spamming any longer');

  channel.send({ embeds: [embedMessage] })
}

// Send a message when the bot is started
function sendBotOnlineMessage() {
  const embedMessage = new EmbedBuilder()
    .setColor('#00CCEE')
    .setTitle('🤖 Bot Online ⚡')
    .setDescription('Ready to give some wdl tours! 🚀');

  const welcomeChannel = client.channels.cache.get(channelIds[2]);
  if (welcomeChannel) {
    welcomeChannel.send({ embeds: [embedMessage] });
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
    await welcomeChannel.send({ embeds: [embedMessage] });
  }
}

// Mass delete new messages
async function pruneMessages(message) {
  // Check if the author has the authorised role
  if (!message.member.roles.cache.some(role => role.name === 'slightly different shade of cyan')) {
    return;
  }

  // Extract the number of messages to prune
  const args = message.content.split(' ');
  const numMessages = parseInt(args[1]);

  // Validate the number of messages
  if (isNaN(numMessages) || numMessages < 1 || numMessages > 50) {
    message.reply('Please specify a number between 1 and 50.');
    return;
  }

  // Confirm the prune operation
  const confirmationMessage = await message.channel.send(`Are you sure you want to prune the last ${numMessages} messages? Type \`confirm\` to proceed.`);

  // Wait for confirmation from the user
  const filter = m => m.author.id === message.author.id && m.content.toLowerCase() === 'confirm';
  try {
    message.channel.awaitMessages({ filter, max: 1, time: 5 * 1000, errors: ['time'] })
      .then(async collected => {
        // Prune the messages
        const messages = await message.channel.messages.fetch({ limit: numMessages + 2 });
        message.channel.bulkDelete(messages.size);
        message.reply(`Successfully pruned the last ${numMessages} messages.`);
        confirmationMessage.delete();
      })
      .catch(() => {
        message.reply('Confirmation timed out. Operation canceled.');
        confirmationMessage.delete();
      });
  } catch (e) {
    console.log(`Error Bulk Deleting Messages: ${e}`);
  }
}

// Check for new releases of Stemlight and post them to #maths-and-code
async function checkForNewRelease() {
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

          channel.send({ embeds });
        }
        updateLastReleaseTag(data.tag_name);
      }

      return; // Success, exit the function
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
}

// Retrieve the last known release tag from a file
function getLastReleaseTag() {
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
