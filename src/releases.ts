import { Client, EmbedBuilder } from 'discord.js';
import { config } from './config';
import { db } from './database';
import { clip, errMsg, readSecret, sendMessage } from './utils';

const MAX_RETRIES = 5;
const MAX_EMBED_DESCRIPTION = 4096;
const GITHUB_PAT = readSecret('GITHUB_PAT', 'PAT.txt'); // optional: public repos work unauthenticated (60 req/hour)

interface GithubRelease {
  tag_name: string;
  body?: string | null;
  html_url: string;
}

/** Checks once now, then (if enabled) on an interval. */
export function startReleasePolling(client: Client): void {
  if (!config.releases.enabled) return;
  const run = async () => {
    console.log('Checking for new Stemlight releases...');
    const found = await checkForNewRelease(client);
    console.log(found ? `New release found: ${db.latestStemlightReleaseTag}` : 'No new releases found.');
  };
  void run();
  setInterval(() => void run(), config.releases.pollIntervalMs);
}

async function checkForNewRelease(client: Client): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const headers: Record<string, string> = { 'User-Agent': 'World Download Bot', Accept: 'application/vnd.github+json' };
      if (GITHUB_PAT) headers.Authorization = `Bearer ${GITHUB_PAT}`;

      const response = await fetch(`https://api.github.com/repos/${config.releases.repo}/releases/latest`, {
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
      if (release.tag_name === db.latestStemlightReleaseTag) return false;

      // First ever run: just remember the current release instead of announcing an old one
      const firstRun = db.latestStemlightReleaseTag === '';
      db.latestStemlightReleaseTag = release.tag_name;
      db.markDirty();
      if (!firstRun) await announce(client, release);
      db.save();
      return !firstRun;
    } catch (error) {
      console.error(`Release check attempt ${attempt} failed: ${errMsg(error)}`);
      if (attempt < MAX_RETRIES) await new Promise(res => setTimeout(res, 5000 * attempt));
      else console.error('Max retries reached. Giving up until the next check.');
    }
  }
  return false;
}

async function announce(client: Client, release: GithubRelease): Promise<void> {
  const channel = client.channels.cache.get(config.channels.mathsAndCode);
  if (!channel) return;

  let body = release.body ?? '';
  const images = [...body.matchAll(/!\[[^\]]*\]\((https:\/\/[^)\s]+)[^)]*\)/g)]
    .map(m => ({ markdown: m[0], url: m[1] }))
    .slice(0, 9); // Discord allows 10 embeds per message
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
