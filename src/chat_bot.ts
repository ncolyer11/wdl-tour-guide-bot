import { User } from './wdl-bot';
const readline = require('readline');
const { wdlHelpKWs, wdlHelpResponse, specifyFarmResponse, specifyFarmKWs, generalExclusionPhrases,
	getPaperResponse, rolesData } = require('./bot_responses');

const JOIN_BUF: number = 10; // Grace period for a new user to be considered new by the bot

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout
});

interface ResponseData {
	responseString: string;
	keywords: string[];
	exclusionWords: string[];
	essentialWords: string[];
	acceptanceProbability: number;
}

interface ResponseLikelihood {
	responseString: string;
	likelihood: number;
}

const botResponses: ResponseData[] = [
	{
		responseString: wdlHelpResponse,
		keywords: wdlHelpKWs,
		exclusionWords: generalExclusionPhrases,
		essentialWords: [],
		acceptanceProbability: 0
	},
	{
		responseString: specifyFarmResponse,
		keywords: specifyFarmKWs,
		exclusionWords: generalExclusionPhrases,
		essentialWords: [],
		acceptanceProbability: 0
	},
	{
		responseString: getPaperResponse(),
		keywords: [],
		exclusionWords: [],
		essentialWords: ['paper'],
		acceptanceProbability: 0
	}
];

function readMessage(userMessage: string, userData: User): string {
	// Remove unwanted punctuation and convert to lowercase
	userMessage = userMessage.replace(/['"`*_]/g, '').toLowerCase();
	// Convert splitString to a Set for faster lookup (O(1) vs O(n) for arrays)
	const splitSet = new Set(userMessage.split(/[\s,.;:!?]+/));

	let responseLikelihoods: ResponseLikelihood[] = [];
	
	// Make sure it matches for whole words only
	for (let i = 0; i < botResponses.length; i++) {
		const responseInfo: ResponseData = botResponses[i];
		
		// Calculate acceptance probability based on matched keywords, stored in 'score'
		let matchedKWs: number = responseInfo.keywords.filter(keyword => {
			// Create a regular expression to match the keyword as a whole word
			const keywordRegex = new RegExp(`\\b${keyword}\\b`);
			return [...splitSet].some(word => keywordRegex.test(word));
		}).length;
		
		// Or if essential words are missing
		// Adjust so you either need 1 or all essential words
		if (responseInfo.essentialWords.every(ess => splitSet.has(ess))) {
			matchedKWs += responseInfo.essentialWords.length;
		} else {
			matchedKWs = 0;
		}

		// Or if any exclusion words are found
		if (responseInfo.exclusionWords.some(exc => splitSet.has(exc))) matchedKWs = 0;
		
		const confidence = getConfidence(userData, matchedKWs);
		if (confidence >= responseInfo.acceptanceProbability) {
			responseLikelihoods.push({responseString: responseInfo.responseString, likelihood: confidence});
		}
		
	}
	// Find the response with the highest likelihood
	const bestResponse = responseLikelihoods.reduce((best, current) => 
		current.likelihood > best.likelihood ? current : best
	)

	// This message still needs to be parsed so that $author$ and $archiveChannel$ can be replaced
	if (bestResponse.likelihood === 0) {
		return "Yea nice one mate";
	} else {
		return bestResponse.responseString;
	}
}

function getConfidence(
	userData: User,
	matchedKWs: number,
): number {
	// Normalise score based on the number of matched keywords
	let KWscore = 1 - 1 / (matchedKWs + 1);
	// Apply role bias (usually 0 for people with roles, 1 for everyone else)
	const roleBias = rolesData.find(roleData => roleData.role === userData.role);
	// Higher score for newer users
	const minutesSinceJoin = Math.max(JOIN_BUF, (Date.now() - userData.timeJoined) / (60 * 1000));
	
	const weightMatchedKWs = 0.5; 
	const weightRoleBias = 0.2;
	const weightMessageCount = 0.1;
	const weightJoinTime = 0.2;

	let weightedScore = 
    weightMatchedKWs * KWscore +
    weightRoleBias * (roleBias ? roleBias.bias : 1) +
    weightMessageCount * 1 / Math.log(userData.totalMessageCount + 2) + // Smoothens reduction for higher counts
    weightJoinTime * Math.min(0.5, Math.exp(-minutesSinceJoin / 10));

	// Normalise score to be between 0 and 1
	// Scale factor 3 and offset - 0.4 were obtained from testing as most values resided in [0.4, 0.7]
	let normalisedScore = Math.max(0, Math.min(1, 3 * (weightedScore - 0.4)));
	return normalisedScore;
}

function main() {
	const mockUser: User = {
		name: 'testUser',
		userId: '12345',
		role: 'none',
		timeJoined: Date.now(),
		totalMessageCount: 2,
		recentMessageCount: 0,
		channels: {}
	};
  rl.question("Enter a message: ", (userInput) => {
		if (userInput) {
			const botResponse = readMessage(userInput, mockUser);
			console.log(botResponse);
		}
		main(); // Recursive call to maintain the loop
  });
}

main();