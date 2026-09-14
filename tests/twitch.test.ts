import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

process.env.TWITCH_CLIENT_ID = 'test-client';
process.env.TWITCH_CLIENT_SECRET = 'test-secret';

import { get, run } from '../src/database/db';
import { LOGIN_PATTERN, normalizeLogin } from '../src/services/twitch/api';
import { listChannels, pollStreams, OFFLINE_GRACE_MS } from '../src/services/twitch/notifier';
import { freshDatabase, GUILD } from './helpers';

type Stream = { id: string; user_login: string; user_name: string; game_name: string; title: string; viewer_count: number; started_at: string; thumbnail_url: string };

let liveStreams: Stream[] = [];
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://id.twitch.tv/oauth2/token')) return json({ access_token: 'app', expires_in: 3600 });
  if (url.includes('/helix/streams')) return json({ data: liveStreams });
  if (url.includes('/helix/videos')) return json({ data: [] });
  return json({ data: [] });
}) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
});

const sent: { channel: string; content?: string }[] = [];
const edits: string[] = [];

function fakeClient() {
  const channel = {
    id: 'chan',
    isTextBased: () => true,
    type: 0,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload: { content?: string }) => {
      sent.push({ channel: 'chan', content: payload.content });
      return { id: `msg${sent.length}`, crosspostable: false };
    },
    messages: { fetch: async (id: string) => ({ id, content: '', edit: async () => void edits.push(id) }) },
  };
  const guild = {
    id: GUILD,
    name: 'Serveur test',
    roles: { cache: new Map() },
    channels: { cache: new Map([['chan', channel]]), find: () => undefined },
    members: { me: {} },
  };
  (guild.channels.cache as unknown as { find: () => undefined }).find = () => undefined;
  return { guilds: { cache: new Map([[GUILD, guild]]) } } as never;
}

describe('Twitch', () => {
  beforeEach(() => {
    freshDatabase([{ id: 'twitch', name: 'Twitch', emoji: '🔴', description: '', toggleable: true, defaultEnabled: true }]);
    sent.length = 0;
    edits.length = 0;
    liveStreams = [];
    run(
      "INSERT INTO twitch_channels (guild_id, login, broadcaster_id, display_name, channel_id, created_at) VALUES (?, 'streamer1', '1', 'Streamer1', 'chan', 0)",
      GUILD,
    );
  });

  it('normalise les pseudos et liens', () => {
    assert.equal(normalizeLogin('https://www.twitch.tv/ZeratoR?ref=x'), 'zerator');
    assert.ok(LOGIN_PATTERN.test('le_streamer_42'));
    assert.ok(!LOGIN_PATTERN.test('a'));
  });

  it('notifie un nouveau live une seule fois, même sur plusieurs sondages', async () => {
    liveStreams = [{ id: 's1', user_login: 'streamer1', user_name: 'Streamer1', game_name: 'Minecraft', title: 'Survie', viewer_count: 10, started_at: new Date().toISOString(), thumbnail_url: 'https://x/{width}x{height}.jpg' }];
    await pollStreams(fakeClient());
    await pollStreams(fakeClient());
    assert.equal(sent.length, 1, 'une seule annonce');
    assert.match(sent[0]!.content ?? '', /Streamer1/);
    const row = listChannels(GUILD)[0]!;
    assert.equal(row.live_stream_id, 's1');
    assert.equal(row.last_game, 'Minecraft');
  });

  it('suit les changements de jeu et le pic de viewers', async () => {
    const start = new Date().toISOString();
    liveStreams = [{ id: 's1', user_login: 'streamer1', user_name: 'Streamer1', game_name: 'Minecraft', title: 'Survie', viewer_count: 10, started_at: start, thumbnail_url: '' }];
    await pollStreams(fakeClient());
    liveStreams = [{ ...liveStreams[0]!, game_name: 'Valorant', viewer_count: 80 }];
    await pollStreams(fakeClient());
    const row = listChannels(GUILD)[0]!;
    assert.equal(row.last_game, 'Valorant');
    assert.equal(row.peak_viewers, 80);
    assert.equal(sent.length, 2, 'annonce du live + annonce du changement de jeu');
  });

  it('tolère une micro-coupure puis termine le live après le délai de grâce', async () => {
    liveStreams = [{ id: 's1', user_login: 'streamer1', user_name: 'Streamer1', game_name: 'Minecraft', title: 'Survie', viewer_count: 10, started_at: new Date().toISOString(), thumbnail_url: '' }];
    await pollStreams(fakeClient());
    liveStreams = [];
    await pollStreams(fakeClient());
    assert.equal(listChannels(GUILD)[0]!.live_stream_id, 's1', 'toujours considéré en live pendant la grâce');
    run('UPDATE twitch_channels SET live_last_seen = ?', Date.now() - OFFLINE_GRACE_MS - 1000);
    await pollStreams(fakeClient());
    assert.equal(get<{ live_stream_id: string | null }>('SELECT live_stream_id FROM twitch_channels')?.live_stream_id, null);
  });
});
