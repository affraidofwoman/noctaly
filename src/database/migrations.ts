export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Migrations versionnées. Ne JAMAIS modifier une migration déjà publiée :
 * ajouter une nouvelle entrée avec un numéro supérieur.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: 'schema initial',
    sql: `
CREATE TABLE guilds (
  guild_id TEXT PRIMARY KEY,
  joined_at INTEGER NOT NULL,
  left_at INTEGER
);

CREATE TABLE guild_settings (
  guild_id TEXT PRIMARY KEY,
  data TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

CREATE TABLE guild_modules (
  guild_id TEXT NOT NULL,
  module TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  PRIMARY KEY (guild_id, module)
);

CREATE TABLE users (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  voice_seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_warnings_user ON warnings (guild_id, user_id, active);

CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  category TEXT NOT NULL,
  type TEXT NOT NULL,
  user_id TEXT,
  actor_id TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_logs_guild ON logs (guild_id, created_at);

CREATE TABLE tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  category TEXT NOT NULL,
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  claimed_by TEXT,
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  closed_by TEXT
);
CREATE UNIQUE INDEX idx_tickets_channel ON tickets (channel_id);
CREATE INDEX idx_tickets_user ON tickets (guild_id, user_id, status);

CREATE TABLE ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_tag TEXT NOT NULL,
  content TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ticket_messages ON ticket_messages (ticket_id, created_at);

CREATE TABLE giveaways (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  host_id TEXT NOT NULL,
  prize TEXT NOT NULL,
  winners_count INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  paused_remaining INTEGER,
  requirements TEXT NOT NULL DEFAULT '{}',
  winners TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_giveaways_status ON giveaways (status, ends_at);

CREATE TABLE giveaway_entries (
  giveaway_id INTEGER NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  entered_at INTEGER NOT NULL,
  PRIMARY KEY (giveaway_id, user_id)
);

CREATE TABLE xp (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX idx_xp_rank ON xp (guild_id, xp DESC);

CREATE TABLE levels (
  guild_id TEXT NOT NULL,
  level INTEGER NOT NULL,
  role_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, level, role_id)
);

CREATE TABLE badges (
  guild_id TEXT NOT NULL,
  badge_id TEXT NOT NULL,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (guild_id, badge_id)
);

CREATE TABLE user_badges (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  badge_id TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  granted_by TEXT,
  PRIMARY KEY (guild_id, user_id, badge_id)
);

CREATE TABLE birthdays (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  month INTEGER NOT NULL,
  last_announced_year INTEGER,
  role_given_at INTEGER,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT,
  channel_id TEXT,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  remind_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_reminders_due ON reminders (sent, remind_at);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  creator_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  game TEXT,
  image TEXT,
  starts_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  reminded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_events_status ON events (status, starts_at);

CREATE TABLE event_rsvps (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  author_id TEXT NOT NULL,
  question TEXT NOT NULL,
  choices TEXT NOT NULL,
  multiple INTEGER NOT NULL DEFAULT 0,
  ends_at INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_polls_status ON polls (status, ends_at);

CREATE TABLE poll_votes (
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  choice INTEGER NOT NULL,
  PRIMARY KEY (poll_id, user_id, choice)
);

CREATE TABLE suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  staff_id TEXT,
  staff_reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE suggestion_votes (
  suggestion_id INTEGER NOT NULL REFERENCES suggestions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  vote INTEGER NOT NULL,
  PRIMARY KEY (suggestion_id, user_id)
);

CREATE TABLE custom_commands (
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  response TEXT NOT NULL,
  as_embed INTEGER NOT NULL DEFAULT 0,
  discord_command_id TEXT,
  uses INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, name)
);

CREATE TABLE auto_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  match_type TEXT NOT NULL DEFAULT 'contains',
  response TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_auto_responses ON auto_responses (guild_id);

CREATE TABLE reaction_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'button',
  mode TEXT NOT NULL DEFAULT 'toggle',
  kind TEXT NOT NULL DEFAULT 'general',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_reaction_roles_message ON reaction_roles (message_id);

CREATE TABLE reaction_role_entries (
  panel_id INTEGER NOT NULL REFERENCES reaction_roles(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL,
  emoji TEXT,
  label TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (panel_id, role_id)
);

CREATE TABLE twitch_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  login TEXT NOT NULL,
  broadcaster_id TEXT,
  display_name TEXT,
  channel_id TEXT NOT NULL,
  role_id TEXT,
  message TEXT,
  color TEXT,
  show_image INTEGER NOT NULL DEFAULT 1,
  notify_end INTEGER NOT NULL DEFAULT 1,
  notify_changes INTEGER NOT NULL DEFAULT 1,
  notify_clips INTEGER NOT NULL DEFAULT 0,
  notify_events INTEGER NOT NULL DEFAULT 0,
  live_stream_id TEXT,
  live_message_id TEXT,
  live_started_at INTEGER,
  live_last_seen INTEGER,
  profile_image TEXT,
  last_title TEXT,
  last_game TEXT,
  last_viewers INTEGER,
  peak_viewers INTEGER,
  last_clip_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (guild_id, login)
);

CREATE TABLE invites (
  guild_id TEXT NOT NULL,
  invited_id TEXT NOT NULL,
  inviter_id TEXT,
  code TEXT,
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  fake INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, invited_id)
);
CREATE INDEX idx_invites_inviter ON invites (guild_id, inviter_id);

CREATE TABLE economy (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  total_earned INTEGER NOT NULL DEFAULT 0,
  last_daily INTEGER NOT NULL DEFAULT 0,
  daily_streak INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE shop_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  emoji TEXT NOT NULL DEFAULT '🎁',
  price INTEGER NOT NULL,
  type TEXT NOT NULL,
  value TEXT,
  stock INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  price INTEGER NOT NULL,
  bought_at INTEGER NOT NULL
);

CREATE TABLE quests (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  quest_id TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id, day, quest_id)
);

CREATE TABLE streaks (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  current INTEGER NOT NULL DEFAULT 0,
  best INTEGER NOT NULL DEFAULT 0,
  last_day TEXT,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE forms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  questions TEXT NOT NULL,
  channel_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (guild_id, name)
);

CREATE TABLE form_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  form_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  answers TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  handled_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE afk (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  since INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE boosts (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  first_boost_at INTEGER NOT NULL,
  last_boost_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE contests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'submissions',
  submit_ends_at INTEGER NOT NULL,
  vote_ends_at INTEGER NOT NULL,
  jury_role_id TEXT,
  reward_coins INTEGER NOT NULL DEFAULT 0,
  reward_xp INTEGER NOT NULL DEFAULT 0,
  reward_role_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_contests_status ON contests (status);

CREATE TABLE contest_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  message_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (contest_id, user_id)
);

CREATE TABLE contest_votes (
  entry_id INTEGER NOT NULL REFERENCES contest_entries(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  jury INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entry_id, user_id)
);

CREATE TABLE stats_daily (
  guild_id TEXT NOT NULL,
  day TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  joins INTEGER NOT NULL DEFAULT 0,
  leaves INTEGER NOT NULL DEFAULT 0,
  voice_seconds INTEGER NOT NULL DEFAULT 0,
  commands INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, day)
);

CREATE TABLE voice_sessions (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE lockdowns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  target_id TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  reason TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE whitelists (
  scope TEXT NOT NULL,
  list TEXT NOT NULL,
  user_id TEXT NOT NULL,
  added_by TEXT,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (scope, list, user_id)
);
CREATE INDEX idx_whitelists_user ON whitelists (user_id);

CREATE TABLE streamers (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color INTEGER,
  footer TEXT,
  logo TEXT,
  background TEXT,
  twitch_login TEXT,
  links TEXT NOT NULL DEFAULT '{}',
  emojis TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE streamer_guilds (
  guild_id TEXT PRIMARY KEY,
  streamer_key TEXT NOT NULL REFERENCES streamers(key) ON DELETE CASCADE
);

CREATE TABLE blacklist (
  scope TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (scope, user_id)
);

CREATE TABLE panels (
  guild_id TEXT NOT NULL,
  key TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  extra TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, key)
);

CREATE TABLE backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  file TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`,
  },
];
