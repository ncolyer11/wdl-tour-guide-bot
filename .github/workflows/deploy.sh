#!/bin/bash

# Stop the bot if it's already running
tmux kill-session -t discord-bot 2>/dev/null

# Start a new tmux session named "discord-bot"
tmux new-session -d -s discord-bot bash -c 'cd src && git pull && npm install && node hfh-bot.js'
