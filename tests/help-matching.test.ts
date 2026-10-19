import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { matchesHelpRequest, matchesFarmQuestion, mentionsPaper, tokenise } from '../src/help-matching';

// The phrases the old bot matched literally (completed into real sentences where the old list had a bare cue)
const shouldMatch = [
  'can i find the download', 'i cant find the schematic', "I can't find the farm", 'where do i find the schematic',
  'where is the farm', 'Where is the download?', 'where is the schematic', 'where is the litematic',
  'where is the world download', 'where is the wdl', 'where are the farm downloads', 'where are the schematics',
  'where are the litematics', 'where are the world downloads', 'where are the wdl', 'where is the rapid',
  'where is the 12', 'where is the 11', 'where is the twelve', 'have a schematic', 'have a litematic',
  'where is the world', 'fungus farm download?', 'anybody got that', 'where download', 'can i have the schematic',
  "wheres the farm", "Where's the download", 'wheres the schematic', 'wheres the litematic',
  'link the schematic', 'link the world download', 'link the schem', 'where the schem', 'where the schematic',
  'where is schematic', 'where is world download', 'where is tree farm', 'where is farm', 'where the world download',
  'where is schem', 'is there a design that works in 1.21', 'is there a farm that is fast', 'do you have a farm that is afk',
  'do you have a design that does 12 types', 'where wdl', 'where is wdl',
  // new coverage the literal list never had
  'where can i get the 12 type tree farm download', 'where is the nether tree farm schematic', 'cannot find the world download',
  'Where is the best tree farm download??', 'is there a litematic for the rapid farm',
];

const shouldNotMatch = [
  'I have a farm in my world', 'where is the best place to download shaders', 'where do you put the schematic',
  'my friend has a world download link', 'i can find it on youtube', 'wallpaper download', 'good morning everyone',
  'is there a way to get xp fast', 'link me your discord', 'the farm is broken', 'where are you from',
];

test('matches help requests', () => {
  const missed = shouldMatch.filter(s => !matchesHelpRequest(s));
  assert.deepEqual(missed, []);
});

test('ignores unrelated chat', () => {
  const wrong = shouldNotMatch.filter(s => matchesHelpRequest(s));
  assert.deepEqual(wrong, []);
});

test('tokenise handles contractions and punctuation', () => {
  assert.deepEqual(tokenise("Where's the world-download?"), ['where', 'is', 'the', 'world', 'download']);
});

test('farm question needs a name, unless excluded', () => {
  assert.equal(matchesFarmQuestion('the nether tree farm is broken'), true);
  assert.equal(matchesFarmQuestion('the nether tree farm is better than the 12 type'), false);
  assert.equal(matchesFarmQuestion('how do i build this'), false);
});

test('paper only as a whole word', () => {
  assert.equal(mentionsPaper('paper devs lol'), true);
  assert.equal(mentionsPaper('this wallpaper is nice'), false);
});
