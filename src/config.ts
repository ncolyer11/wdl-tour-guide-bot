/**
 * Everything you're likely to tweak lives here: IDs, limits, feature switches, moderation tuning.
 * (Phrases and message text live in strings.ts.)
 */
export const config = {
  // ---------------------------------------------------------------------------
  // PRIVILEGED INTENT SWITCHES. Leave false until Discord approves the intent (and it is toggled on
  // in the Developer Portal), then flip to true and restart.
  //
  //  messageContent = false -> the bot can't read message text, so these are OFF:
  //      help auto-replies, "paper" reply, scam detection, deleted-message log.
  //  guildMembers   = false -> no join/leave events, so:
  //      welcomes fall back to Discord's own "X joined" message, and NO per-user data is stored
  //      (without leave events we couldn't delete it when people leave).
  // ---------------------------------------------------------------------------
  intents: {
    messageContent: false,
    guildMembers: false,
  },

  owners: {
    // /admin commands only accept these IDs (also: OWNER_USER_IDS env var, comma separated)
    userIds: ['460277745264492544'],
    // Members with one of these role names also count as owner for the #chunk-manipulation cleaner and for
    // bypassing auto-reply limits. Role names are weaker than IDs, so they can't use /admin.
    roleNames: ['slightly different shade of cyan'],
  },

  guildId: '930027805398429736',

  channels: {
    archive: '1019870085617291305',
    modLog: '1094609234978668765', // deleted messages, moderation actions, leave notices
    mathsAndCode: '1036212683374088283', // Stemlight release announcements
    chunkManipulation: '930048455777325076', // owner-only channel, everyone else's messages are removed
    welcome: '930027805398429739', // online/offline notices
  },

  // Channels where the bot auto-replies to help requests
  helpChannelIds: [
    '1092283954805084200', // general
    '930033193170661436', // question us
    '930027805398429739', // welcome
    '930037624893231114', // simple
    '1094609234978668765', // bot testing
  ],

  // Members with these roles never receive auto-replies
  exemptRoleNames: ['fungus enthusiast', 'trusted user', 'nft', 'hamper', 'carter', 'demoman'],

  emojis: {
    froge: '<:Froge:930083494938411018>',
  },

  // Links in /downloads and the welcome DM (message IDs inside the archive channel)
  shortcuts: [
    { emoji: '<:warped_stem:1264941326621999215>', label: '12 Type Tree Farm Download', messageId: '1221071923803586560' },
    { emoji: '<:crimson_stem:1264941385673605150>', label: 'Simple & Rapid Nether Tree Farm Download', messageId: '1096118419201462303' },
    { emoji: '<:shroomlight:1264941341129834528>', label: 'All Farm World Downloads & Schematics', messageId: '1019870085617291305' },
  ],

  limits: {
    hourlyBotMessages: 10,
    hourlyPerUserReplies: 3,
    paperCooldownMs: 60_000,
    saveIntervalMs: 15 * 60_000,
    backupIntervalMs: 12 * 60 * 60_000,
  },

  releases: {
    enabled: true,
    repo: 'ncolyer11/Stemlight',
    pollIntervalMs: 15 * 60_000,
  },

  moderation: {
    windowMs: 30_000, // how far back to look when adding up a user's scam score
    threshold: 6, // total score at which the bot acts
    newMemberDays: 7, // only members who joined more recently than this are punished; others just alert mods
    action: 'timeout' as 'timeout' | 'kick' | 'ban', // timeout is reversible, ban is not
    timeoutMinutes: 24 * 60,
    banDeleteSeconds: 24 * 60 * 60,
    alertRoleId: '', // role to ping in the mod log when something is flagged (empty = no ping)
    weights: {
      link: 1, // only counts alongside another signal; a bare link alone scores 0
      invite: 2,
      massMention: 2, // @everyone / @here
      strongKeyword: 2,
      weakKeyword: 1,
      keywordCap: 2,
      duplicateSameChannel: 1,
      duplicateCrossChannel: 4, // same text in 2+ channels is the classic scam-bot signature
    },
    strongKeywords: ['free nitro', 'nitro gift', 'free gift', 'free giveaway', 'free money', 'airdrop', 'steam gift'],
    weakKeywords: ['steam', 'discord', 'nitro', 'bitcoin', 'crypto', 'gift', 'giveaway', 'hack', 'claim', '$'],
  },
};
