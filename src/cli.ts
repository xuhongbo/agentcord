const command = process.argv[2];

switch (command) {
  case 'setup': {
    // Alias: agentcord setup → agentcord config setup
    const { handleConfig } = await import('./config-cli.ts');
    await handleConfig(['setup']);
    break;
  }
  case 'config': {
    const { handleConfig } = await import('./config-cli.ts');
    await handleConfig(process.argv.slice(3));
    break;
  }
  case 'start':
  case undefined: {
    const { startBot } = await import('./bot.ts');
    console.log('agentcord starting...');
    await startBot();
    break;
  }
  case 'daemon': {
    const { handleDaemon } = await import('./daemon.ts');
    await handleDaemon(process.argv[3]);
    break;
  }
  case 'help':
  case '--help':
  case '-h': {
    console.log(`
  \x1b[1magentcord\x1b[0m — Discord bot for managing Claude Code sessions

  \x1b[1mUsage:\x1b[0m
    agentcord                      Start the bot
    agentcord config setup         Interactive configuration wizard
    agentcord config get <key>     Read a config value
    agentcord config set <k> <v>   Write a config value
    agentcord config list          List all config values
    agentcord config path          Show config file path
    agentcord daemon               Manage background service (install/uninstall/status)
    agentcord help                 Show this help message

  \x1b[1mQuick start:\x1b[0m
    1. agentcord config setup   Configure Discord app, token, permissions
    2. agentcord                Start the bot
    3. /session new <name>      Create a session in Discord

  \x1b[2mhttps://github.com/xuhongbo/agentcord\x1b[0m
`);
    break;
  }
  default:
    console.error(`Unknown command: ${command}`);
    console.error('Run \x1b[36magentcord help\x1b[0m for usage.');
    process.exit(1);
}
