import * as fs from 'fs';
import * as path from 'path';

export {};

interface HiddenConfig {
    gemini: { API_key: string };
    discord: { bot_token: string };
    github: { PAT: string };
}

const { GoogleGenerativeAI } = require("@google/generative-ai");

const apiKey = getKeyByName('gemini');
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const tagPrompt = "The following message is from a discord user who has just joined a help minecraft server for farms, and the user has just asked a question about a farm but they either haven't specified what type of farm it is, or they have specified what type of farm it is and you should label the message with the appropriate tag for what type of farm it is. If no farm is directly specified, tag it as unknown farm. Your reply must be a lits of comma separated tags from the following list: playerless nether tree farm, playerfull nether tree farm, simple universal tree farm, the sss, the rapid nether tree farm, unkown farm. Also if they provide additional information about their problem such as a bottom block not being broken, the tnt duper not working, running out of saplings, then make a tag for that too. Their message is: ";


async function main() {
    const userMessage = "I need help with the simple tree farm, the tnt duper is broken";
    const tags = await getMessageTagsWithGemini(userMessage);
    console.log(tags);
}

// main();

////////////////////////////////

async function getMessageTagsWithGemini(userMessage: string): Promise<string[]> {
    const prompt = tagPrompt + userMessage;
    const result = await model.generateContent(prompt);
    const response = result.response.text();
    return response.split(', ');
}

function getKeyByName(name: string): string | null {
    const filePath = path.join(__dirname, 'hidden.json');
    try {
        const data = fs.readFileSync(filePath, 'utf8');
        const config: HiddenConfig = JSON.parse(data);

        switch (name) {
            case 'gemini':
                return config.gemini.API_key;
            case 'discord':
                return config.discord.bot_token;
            case 'github':
                return config.github.PAT;
            default:
                return null;
        }
    } catch (error) {
        console.error('Error reading or parsing hidden.json:', error);
        return null;
    }
}

// Testing with structured output
const model2 = genAI.getGenerativeModel({
  model: "gemini-2.0-flash-exp",
});

const generationConfig = {
  temperature: 0.1,
  topP: 0.95,
  topK: 40,
  maxOutputTokens: 8192,
  responseMimeType: "application/json",
  responseSchema: {
    type: "object",
    properties: {
      choosing_or_issue: {
        type: "boolean"
      },
      choosing: {
        type: "object",
        properties: {
          general_farm_tag: {
            type: "string"
          },
          feature_tags: {
            type: "array",
            items: {
              type: "string"
            }
          }
        },
        required: [
          "general_farm_tag",
          "feature_tags"
        ]
      },
      issue: {
        type: "object",
        properties: {
          specific_farm_tag: {
            type: "string"
          },
          issue_tags: {
            type: "array",
            items: {
              type: "string"
            }
          }
        },
        required: [
          "specific_farm_tag",
          "issue_tags"
        ]
      }
    },
    required: [
      "choosing_or_issue"
    ]
  },
};

async function run() {
  const inputSentence = "hows the weather in sydney";
  const parts = [
    {text: "input: for the 12 type tree farm is it possible to add more filtered hoppers?"},
    {text: "output: {  \"choosing_or_issue\": false,  \"issue\": {    \"specific_farm_tag\": \"vuntf_v2\",    \"issue_tags\": [      \"add_filters\"    ]  }}"},
    {text: `input: ${inputSentence}`},
    {text: "output: "},
  ];

  const result = await model2.generateContent({
    contents: [{ role: "user", parts }],
    generationConfig,
  });
  console.log(result.response.text());
}

run();