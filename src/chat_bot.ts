const readline = require('readline');
const { wdlHelpKWs, wdlHelpResponse, specifyFarmResponse, specifyFarmKWs, generalExclusionPhrases,
	getPaperResponse, rolesData } = require('./bot_responses');
import { User } from './wdl-bot';

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
		let score: number = responseInfo.keywords.filter(keyword => {
			// Create a regular expression to match the keyword as a whole word
			const keywordRegex = new RegExp(`\\b${keyword}\\b`);
			return [...splitSet].some(word => keywordRegex.test(word));
		}).length;
		
		// Or if essential words are missing
		// Adjust so you either need 1 or all essential words
		if (responseInfo.essentialWords.every(ess => splitSet.has(ess))) {
			score += responseInfo.essentialWords.length;
		} else {
			score = 0;
		}

		// Or if any exclusion words are found
		if (responseInfo.exclusionWords.some(exc => splitSet.has(exc))) {
			score = 0;
		}
		
		const totalKeywords = responseInfo.keywords.length + responseInfo.essentialWords.length;
		const confidence = getConfidence(score, userData, totalKeywords);
		if (confidence >= responseInfo.acceptanceProbability) {
			responseLikelihoods.push({responseString: responseInfo.responseString,
									  likelihood: confidence});
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
	score: number,
	userData: User,
	totalKeywords: number
): number {
	// Apply role bias (usually 0 for people with roles, 1 for everyone else)
	const roleBias = rolesData.find(roleData => roleData.role === userData.role);
	if (roleBias) {
		score *= roleBias.bias;
	}

	// Higher score for newer users
	score *=  2 / userData.totalMessageCount; 

	// Later I'll factor in the time a user has been a member for
	return score / totalKeywords;
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