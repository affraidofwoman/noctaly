import { Client, GatewayIntentBits, Options, Partials } from 'discord.js';

export function creerClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildExpressions,
      GatewayIntentBits.GuildInvites,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.GuildMember, Partials.User],
    allowedMentions: { parse: ['users', 'roles'], repliedUser: false },
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 200,
      ReactionManager: 50,
      PresenceManager: 0,
      GuildStickerManager: 0,
      GuildScheduledEventManager: 0,
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      messages: { interval: 1800, lifetime: 3600 },
    },
  });
}
