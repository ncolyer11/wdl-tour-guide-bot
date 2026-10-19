import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { SpamTracker, scoreMessage } from '../src/moderation';
import { config } from '../src/config';

const THRESHOLD = config.moderation.threshold;
const scam = '@everyone FREE NITRO gift for all! claim here https://dlscord-gifts.example/claim';

test('normal chat and plain links score zero', () => {
  for (const text of [
    'has anyone tried the new steam update?',
    'check out my farm https://youtu.be/abc123',
    'gift ideas for my friend lol',
    'https://example.com/a https://example.com/b',
    'the crypto bro at work is annoying',
  ]) assert.equal(scoreMessage(text).score, 0, text);
});

test('obvious scams score highly', () => {
  assert.ok(scoreMessage(scam).score >= 5);
  assert.ok(scoreMessage('join https://discord.gg/abcdef for a free giveaway').score >= 4);
});

test('full-width / styled characters do not dodge the filter', () => {
  assert.ok(scoreMessage('＠everyone ｆｒｅｅ ｎｉｔｒｏ https://x.example/y').score >= 4);
});

test('one scam message is not enough, a copy in another channel is', () => {
  const t = new SpamTracker<string>();
  const first = t.assess('u1', 'chanA', scam, 'm1', 1000);
  assert.ok(first.total < THRESHOLD, `first message total ${first.total}`);
  const second = t.assess('u1', 'chanB', scam.replace('dlscord-gifts.example/claim', 'other-site.example/x'), 'm2', 2000);
  assert.ok(second.total >= THRESHOLD, `second message total ${second.total}`);
  assert.deepEqual(second.flagged, ['m1', 'm2']);
  assert.ok(second.reasons.includes('same message in several channels'));
});

test('posting the same plain link in 3 channels trips it, 2 does not', () => {
  const t = new SpamTracker<string>();
  const link = 'https://spam.example/buy-now';
  assert.ok(t.assess('u2', 'a', link, '1', 0).total < THRESHOLD);
  assert.ok(t.assess('u2', 'b', link, '2', 100).total < THRESHOLD);
  assert.ok(t.assess('u2', 'c', link, '3', 200).total >= THRESHOLD);
});

test('old messages age out of the window', () => {
  const t = new SpamTracker<string>();
  t.assess('u3', 'a', scam, '1', 0);
  const later = t.assess('u3', 'b', scam, '2', config.moderation.windowMs + 1);
  assert.deepEqual(later.flagged, ['2']);
});

test('different users do not affect each other', () => {
  const t = new SpamTracker<string>();
  t.assess('x', 'a', scam, '1', 0);
  assert.ok(t.assess('y', 'b', scam, '2', 10).total < THRESHOLD);
});
