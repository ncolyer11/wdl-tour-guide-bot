function read_message(userMessage: string, role: string, memberDuration: number): string {
    var splitString: string[] = userMessage.split(/[\s,.;:!?]+/)

    return "hi"
}

client.on('messageCreate', async (message) => {
  
    const chunkManipulationChannelId = '930048455777325076';
    if (message.channel.id === chunkManipulationChannelId) {
      message.delete().catch(error => console.error('Error deleting message:', error));
      console.log("Kept #chunk-manipulation clean")
    }
  
    checkBan(message);
    let botMessageCount = dataStore.botMessageCount;
    if (canSendMessage(message, true)) {
      if (triggerPhrases.some(phrase => message.content
                                .toLowerCase()
                                .replace(/['",.\-`()]/g, '')
                                .includes(phrase)
        )) {
        message.channel.send(`Hey ${message.author}, please see <#${archiveChannel}> for all world downloads and schematics.`);
        console.log(`Sent message ${botMessageCount} in response to "world download"`);
        incrementUserReplyCount(message.author.username);
        botMessageCount++;
      } else if (otherPhrases.some(phrase => message.content.toLowerCase().includes(phrase))
      && !excPhrases.some(
        phrase => new RegExp('\\b' + phrase + '\\b', 'i').test(message.content))) {
          message.channel.send(
            `Hey ${message.author}, this server has many different tree farm designs by many different people.\n\nPlease include the name of the farm you need help with.`
          );
          console.log(`Sent message ${botMessageCount} in response to "tree farm"`);
          incrementUserReplyCount(message.author.username);
          botMessageCount++;
        }
      }
      
    if (canSendMessage(message, false)) {
      if (message.content.toLowerCase().includes('paper')) {
    
        const now = Date.now();
        if (now - dataStore.lastPaperMsgTimestamp >= 60 * 1000) { // 1 minute cooldown
          // Randomly decide the timestamp
          const timestamp = Math.random() < 0.1 ? 14 : 1128; // 1 in 10 chance for 14, 9 in 10 chance for 1128
    
          message.channel.send(`[paper lol](<https://youtube.com/watch?v=XjjXYrMK4qw&t=${timestamp}s>)`);
          console.log('Sent message in response to paper devs being tarts');
          incrementUserReplyCount(message.author.username);
          botMessageCount++;
          dataStore.lastPaperMsgTimestamp = now; // update the last message timestamp
        }
      }
    }
  });