interface RoleBias {
    role: string;
    bias: number; // Bias towards ignoring messages sent from this role (0 ignore, 1 always respond)
}

// trigger phrases
exports.wdlHelpKWs = [
    'can', 'find', 'i', 'where', 'farm', 'download', 'schematic', 'litematic',
    'world', 'wdl', 'are', 'rapid', '12', '11', 'twelve', 'have', 'fungus', 'anybody', 'got', 'that',
    'wheres', 'link', 'tree', 'design'
];

exports.wdlHelpResponse = `Hey $author$, please see $archiveChannel$ for all world downloads and schematics.`

// Issue is the bot goes word by word, but this trigger kinda relies on phrases sooo
exports.specifyFarmKWs = [
    'the tree farm',
    'the wood farm',
    'the machine',
    'the nether tree farm',
    'problem tree farm'
];
exports.specifyFarmResponse = `Hey $author$, this server has many different tree farm designs by many different people.\n\nPlease include the name of the farm you need help with.`

exports.generalExclusionPhrases = [
    'but',
    'than',
    '11',
    '12',
    'type',
    'sss',
    'simple',
    '"',
    'farms',
    '13000',
    '13,000'
];

export function getPaperResponse(): string {
    var timestamp: number = Math.random() < 0.1 ? 14 : 1128;
    return `[paper lol](<https://youtube.com/watch?v=XjjXYrMK4qw&t=${timestamp}s>)`;
}

export const rolesData: RoleBias[] = [
    {role: 'nft', bias: 0.2},
    {role: 'fungus enthusiast', bias: 0},
    {role: 'trusted user', bias: 0},
    {role: 'hamper', bias: 0},
    {role: 'carter', bias: 0},
    {role: 'demoman', bias: 0}
];
