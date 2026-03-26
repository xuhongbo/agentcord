import { existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const command = args[0];

if (command === 'setup' || command === '--setup') {
  console.log(`
threadcord setup
────────────────
1. Copy .env.example to .env:

   cp .env.example .env

2. Fill in your Discord credentials:

   DISCORD_TOKEN=your-bot-token
   DISCORD_CLIENT_ID=your-client-id
   DISCORD_GUILD_ID=your-guild-id   (optional, for faster command registration)

3. Set allowed users:

   ALLOWED_USER_IDS=your-discord-user-id

4. Set the default working directory:

   DEFAULT_DIRECTORY=/path/to/your/code

5. Start the bot:

   threadcord start
   # or: node dist/cli.js

Discord structure:
  Server
  └─ Category  ← represents one project/repo  (/project setup here)
     ├─ #history  ← Forum, auto-created for archived sessions
     └─ #claude-feature-x  ← session channel  (/agent spawn)
        └─ [sub:claude] worker  ← Thread for subagent  (/subagent run)

Quick start in Discord:
  1. Create a Category in your server (right-click > Create Category)
  2. Create any text channel inside it, then run /project setup
  3. Run /agent spawn label:my-task to create a session channel
  4. Open the new channel and start chatting with the agent
`);
} else {
  // Check .env exists
  const envPath = join(process.cwd(), '.env');
  if (!existsSync(envPath)) {
    console.warn('[warn] No .env file found. Run `threadcord setup` for instructions.');
  }

  const { startBot } = await import('./bot.ts');
  await startBot();
}
