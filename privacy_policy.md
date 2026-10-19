# Privacy Policy: Huge Fungi Huggers Bot (wdl-tour-guide-bot)

*Last updated: 19th Oct 2026.*

## Who runs this bot
Operated by ncolyer  for the Huge Fungi Huggers Discord server.
Contact for privacy questions or requests: @ncolyer on Discord.

## What the bot stores
Stored persistently, **encrypted at rest (AES-256-GCM)**:

| Data | Purpose |
|---|---|
| Discord user ID | Keep a per-user message count and remember opt-out choices |
| Time the bot first saw you | Housekeeping |
| Number of messages you have sent | Server activity statistics |

Also stored: a list of user IDs that have opted out.

## What the bot does *not* store
Message content, usernames, roles, avatars, DMs, or anything from servers other than the one it is installed in.

## Short-lived data (memory only, never saved, lost on restart)
- Timestamps of scam-looking messages (about 20 seconds) for automatic scam detection.
- Per-user reply counters (1 hour) for rate limiting.

These run even for users who opted out, so opting out cannot be used to evade scam detection.

## Why the bot uses privileged intents
- **Message Content:** to recognise common help questions and to detect scam links.
  Message text is processed in memory and is not stored.
- **Server Members:** to send welcome messages and to delete stored data when a member leaves.

## Moderation logs
When a member deletes a message, or the bot bans/kicks an account for scam spam, a copy of the message is posted to a private moderator channel in the server. This copy is kept in Discord, not in the bot's database. Users who opted out are excluded from the deleted-message log.

## Retention
A user's record is deleted when they leave the server, opt out, or are banned. Encrypted backups are overwritten on a rolling basis.

## Your choices
- `/privacy info`: how data is handled
- `/privacy mydata`: shows exactly what is stored about you
- `/privacy optout`: stops storage and deletes your record immediately
- `/privacy optin`: allows storage again

You can also contact @ncolyer on Discord to request access or deletion.

## Security
Data is encrypted with AES-256-GCM using a key held separately from the data files. Files are written atomically and are readable only by the bot's system account.

## Sharing
Data is not sold or shared with third parties. The bot communicates with Discord's API and, to check for new releases, GitHub's public API (no user data is sent).

## Children
Users must meet Discord's minimum age requirement. The bot does not knowingly collect data beyond what Discord provides.

## Changes
Changes will be reflected here with an updated date.