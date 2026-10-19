import { config } from './config';

/**
 * Help-request detection is rule based instead of a long list of exact phrases.
 *
 *   match = <cue> + up to `maxSkip` filler/descriptor words + <target>
 *
 * e.g. "where is the 12 type tree farm download", "cant find the schem", "link the world download".
 * Add words to these lists to widen what gets recognised; help-matching.ts does the rest.
 * Text is lower-cased and stripped of punctuation first, so "Where's" becomes "where is".
 */
export const helpRequestRules = {
  // "<cue> ... <strong or weak target>"
  askCues: [
    'where is', 'where are', 'where can i find', 'where can i get', 'where do i find', 'where do i get', 'where',
    'can i find', 'cant find', 'cannot find', 'couldnt find', 'can i have', 'link', 'anybody got', 'anyone got'],
  // "<cue> ... <strong target>", or a weak target followed by "that" ("is there a farm that ...")
  haveCues: ['have a', 'do you have a', 'is there a', 'is there any', 'got a'],
  strongTargets: ['download', 'downloads', 'schematic', 'schematics', 'litematic', 'litematics', 'schem', 'schems', 'wdl'],
  weakTargets: ['farm', 'farms', 'design', 'designs', 'world', 'worlds', '12', '11', 'twelve', 'rapid'],
  // words allowed between the cue and the target
  skippable: [
    'the', 'a', 'an', 'that', 'this', 'those', 'these', 'any', 'some', 'my', 'your', 'of', 'for',
    'good', 'best', 'nice', 'new', 'cool', 'nether', 'tree', 'fungus', 'wood', 'type', 'simple',
    'rapid', 'world', 'worlds', 'farm', 'farms', 'design', 'designs', '12', '11', 'twelve',
  ],
  maxSkip: 4,
  // short replies that only make sense as a follow-up ("anybody got that?")
  exactPhrases: ['anybody got that', 'anyone got that', 'farm download'],
};

// "What farm design do you mean?" detection (plain phrases, matched on word boundaries)
export const farmQuestionPhrases = ['the wood farm', 'the machine', 'the nether tree farm', 'problem tree farm'];
// Messages containing any of these are never treated as a farm question
export const farmQuestionExclusions = [
  'but', 'than', '11', '12', 'type', 'sss', 'simple', '"', 'farms', 'you', '13000', '13,000',
];

export interface WeightedMessage {
  weight: number; // relative rarity: a weight-6 message shows up twice as often as a weight-3 one
  text: string; // {member} {archive} {Froge} are filled in at send time
}

// To add a welcome message: append a line. To make it rarer, lower its weight.
export const welcomeMessages: WeightedMessage[] = [
  { weight: 7, text: "Welcome to Huge Fungi Huggers, {member}! We're so glad you're here {Froge}" },
  { weight: 3, text: "Hey {member}, welcome to the server! Enjoy all the free wood here." },
  { weight: 3, text: "Greetings, {member} {Froge} Enjoy your time collecting shroomlights here." },
  { weight: 3, text: "Howdy {member}! We hope you brought spare nylium." },
  { weight: 1, text: "Hello {member}, welcome to the other tree server {Froge} How's your day going?" },
  { weight: 2, text: "Welcome, {member}! Hope you find what you're looking for here! (I really don't know how you couldn't)" },
  { weight: 3, text: "Howdy {member}, did you know {archive} has all the nether tree farms you could dream of?" },
  { weight: 4, text: "Yo, {member}! Welcome to the Huge Fungi Huggers server, feel free to ask if you need help with anything." },
  { weight: 4, text: "Welcome to Huge Fungi Huggers, {member}! We're happy to have you here. Have a great time exploring the nether trees." },
  { weight: 4, text: "Hi {member}, did you know {archive} has some awesome designs made by our community? Feel free to check them out {Froge}" },
  { weight: 3, text: "Yo, {member}! Welcome to Huge Fungi Huggers, where we have some of the nether tree farms around. Enjoy your stay!" },
  { weight: 3, text: "Welcome to the server, {member}! We hope you find everything you're looking for this side of the overworld." },
  { weight: 6, text: "Greetings, {member}! Our community is always happy to welcome new members to our nether tree paradise." },
  { weight: 3, text: "Welcome to Huge Fungi Huggers, {member} {Froge} Our trees may be on fire, but our community is always cool." },
  { weight: 1, text: "Hey {member}, welcome to the nether tree gang! Let's chop it up and make some charcoal. Oh wait..." },
  { weight: 4, text: "Who's that, hiding in the nether roots? Oh! It’s {member}. Welcome to the server." },
  { weight: 2, text: "{member} has joined the server, I wonder if they know about all the schematics in {archive}..." },
  { weight: 7, text: "{member} just slid into some twisting vines." },
  { weight: 7, text: "Welcome {member}, enjoy your stay {Froge}" },
  { weight: 5, text: "Happy you're here, {member} {Froge}" },
  { weight: 2, text: "Hey {member}, welcome aboard {Froge}" },
  { weight: 6, text: "Welcome to the Huge Fungi Huggers community, {member}!" },
  { weight: 7, text: "Hello {member}, welcome to our server {Froge}" },
  { weight: 3, text: "Welcome {member}, Have fun exploring {archive}." },
  { weight: 4, text: "What a pleasant surprise to see {member}." },
  { weight: 6, text: "Greetings, {member}! Welcome to our server {Froge}" },
  { weight: 5, text: "Welcome to the server, {member} {Froge} Enjoy yourself!" },
];

/** The bullet list of key download links used by /downloads and the welcome DM. */
export function buildShortcutsText(): string {
  const prefix = `https://discord.com/channels/${config.guildId}/`;
  return config.shortcuts.map(s => ` ${s.emoji}  [**${s.label}**](${prefix}${s.messageId})`).join('\n');
}
