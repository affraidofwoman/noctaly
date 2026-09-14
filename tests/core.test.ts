import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { all, get, run, transaction } from '../src/database/db';
import { deepMerge, defaultConfig, getConfig, resetConfigCache, updateConfig } from '../src/core/guildConfig';
import { isModuleEnabled, setModuleEnabled } from '../src/core/moduleManager';
import { matchPrefix, requiredLevel, resolveGuildId, splitArgs } from '../src/core/dispatcher';
import { Cooldowns, SlidingWindowLimiter } from '../src/core/rateLimit';
import { formatDuration, parseDateTime, parseDuration, zonedParts } from '../src/core/time';
import { renderTemplate } from '../src/core/variables';
import { PermLevel, type BotModule, type SlashCommand } from '../src/core/types';
import { freshDatabase, GUILD } from './helpers';

const dummy = (id: string, toggleable = true, defaultEnabled = true): BotModule => ({ id, name: id, emoji: '🧪', description: id, toggleable, defaultEnabled });

describe('base de données', () => {
  beforeEach(() => freshDatabase());

  it('applique les migrations et crée toutes les tables attendues', () => {
    const tables = new Set(all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name));
    for (const t of ['guilds', 'guild_settings', 'users', 'warnings', 'tickets', 'ticket_messages', 'giveaways', 'giveaway_entries', 'xp', 'levels', 'badges', 'birthdays', 'reminders', 'events', 'polls', 'suggestions', 'custom_commands', 'auto_responses', 'reaction_roles', 'twitch_channels', 'invites', 'economy', 'quests', 'forms', 'logs', 'whitelists', 'streamers', 'blacklist', 'backups']) {
      assert.ok(tables.has(t), `table manquante : ${t}`);
    }
    assert.equal(get<{ v: number }>('SELECT MAX(version) AS v FROM schema_migrations')?.v, 1);
  });

  it('annule une transaction en erreur', () => {
    assert.throws(() =>
      transaction(() => {
        run('INSERT INTO guilds (guild_id, joined_at) VALUES (?, ?)', 'x', 1);
        throw new Error('boom');
      }),
    );
    assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM guilds')?.n, 0);
  });

  it('convertit les booléens et undefined en paramètres SQLite', () => {
    run('INSERT INTO afk (guild_id, user_id, reason, since) VALUES (?, ?, ?, ?)', GUILD, 'u', 'test', 1);
    run('INSERT INTO warnings (guild_id, user_id, moderator_id, reason, created_at, active) VALUES (?, ?, ?, ?, ?, ?)', GUILD, 'u', 'm', 'r', 1, true);
    assert.equal(get<{ active: number }>('SELECT active FROM warnings')?.active, 1);
  });
});

describe('configuration par serveur', () => {
  beforeEach(() => freshDatabase());

  it('fusionne les valeurs stockées avec les défauts (tableaux remplacés, objets fusionnés)', () => {
    const merged = deepMerge(defaultConfig(), { welcome: { channelId: '1' }, automod: { links: { whitelist: ['a.com'] } }, inconnu: 1 });
    assert.equal(merged.welcome.channelId, '1');
    assert.equal(merged.welcome.useEmbed, true);
    assert.deepEqual(merged.automod.links.whitelist, ['a.com']);
    assert.equal((merged as unknown as Record<string, unknown>).inconnu, undefined);
  });

  it('ignore une valeur stockée du mauvais type', () => {
    const merged = deepMerge(defaultConfig(), { xp: { min: 'beaucoup' } });
    assert.equal(merged.xp.min, 15);
  });

  it('persiste et isole la configuration de chaque serveur', () => {
    updateConfig(GUILD, (c) => void (c.prefixes.general = '!'));
    resetConfigCache();
    assert.equal(getConfig(GUILD).prefixes.general, '!');
    assert.equal(getConfig('autre').prefixes.general, '=');
  });

  it('active et désactive les modules par serveur', () => {
    freshDatabase([dummy('core', false), dummy('xp', true, false), dummy('tickets')]);
    assert.equal(isModuleEnabled(GUILD, 'core'), true);
    assert.equal(isModuleEnabled(GUILD, 'xp'), false);
    setModuleEnabled(GUILD, 'tickets', false);
    assert.equal(isModuleEnabled(GUILD, 'tickets'), false);
    assert.equal(isModuleEnabled('autre', 'tickets'), true);
    setModuleEnabled(GUILD, 'core', false);
    assert.equal(isModuleEnabled(GUILD, 'core'), true, 'un module cœur reste actif');
    assert.equal(isModuleEnabled(GUILD, 'supprime'), false, 'un module retiré est inactif sans planter');
  });
});

describe('préfixes et arguments', () => {
  const prefixes = { sanction: '+', salon: '&', general: '=', owner: '.', music: 'm!' };

  it('reconnaît le domaine selon le préfixe, le plus long d’abord', () => {
    assert.deepEqual(matchPrefix('m!play test', prefixes), { domain: 'music', name: 'play', rest: 'test' });
    assert.deepEqual(matchPrefix('+ban 123 spam', prefixes), { domain: 'sanction', name: 'ban', rest: '123 spam' });
    assert.deepEqual(matchPrefix('.owner', prefixes), { domain: 'owner', name: 'owner', rest: '' });
    assert.equal(matchPrefix('bonjour', prefixes), null);
    assert.equal(matchPrefix('= ', prefixes), null);
  });

  it('respecte les guillemets', () => {
    assert.deepEqual(splitArgs('a "b c" \'d e\' f'), ['a', 'b c', 'd e', 'f']);
  });

  it('calcule le niveau requis par sous-commande', () => {
    const cmd = { level: PermLevel.MEMBER, subLevels: { setup: PermLevel.ADMIN, 'grp sub': PermLevel.STAFF } } as unknown as SlashCommand;
    assert.equal(requiredLevel(cmd, null, 'setup'), PermLevel.ADMIN);
    assert.equal(requiredLevel(cmd, 'grp', 'sub'), PermLevel.STAFF);
    assert.equal(requiredLevel(cmd, null, 'list'), PermLevel.MEMBER);
  });

  it('retrouve le serveur dans les arguments d’un événement', () => {
    assert.equal(resolveGuildId([{ guild: { id: '1' } }]), '1');
    assert.equal(resolveGuildId([{ guildId: '2' }]), '2');
    assert.equal(resolveGuildId([{ message: { guildId: '3' } }]), '3');
    assert.equal(resolveGuildId([null, 4]), null);
  });
});

describe('temps et durées', () => {
  it('lit les durées françaises', () => {
    assert.equal(parseDuration('2h30'), 9_000_000);
    assert.equal(parseDuration('1j 12h'), 129_600_000);
    assert.equal(parseDuration('45m'), 2_700_000);
    assert.equal(parseDuration('1 semaine'), 604_800_000);
    assert.equal(parseDuration('10'), 600_000);
    assert.equal(parseDuration('abc'), null);
    assert.equal(parseDuration('2h abc'), null);
  });

  it('formate les durées', () => {
    assert.equal(formatDuration(3_900_000), '1 h 5 min');
    assert.equal(formatDuration(500), '0 s');
  });

  it('convertit une date locale Europe/Paris en UTC (hiver et été)', () => {
    assert.equal(new Date(parseDateTime('25/12/2026', '21h', 'Europe/Paris')!).toISOString(), '2026-12-25T20:00:00.000Z');
    assert.equal(new Date(parseDateTime('14/07/2027', '21:30', 'Europe/Paris')!).toISOString(), '2027-07-14T19:30:00.000Z');
    assert.equal(parseDateTime('31/02/2027', '10h', 'Europe/Paris'), null);
    assert.equal(zonedParts(Date.UTC(2026, 0, 1, 23, 30), 'Europe/Paris').day, 2);
  });
});

describe('limiteurs', () => {
  it('fenêtre glissante', () => {
    const l = new SlidingWindowLimiter(2, 1000);
    assert.equal(l.hit('a', 0), true);
    assert.equal(l.hit('a', 10), true);
    assert.equal(l.hit('a', 20), false);
    assert.equal(l.hit('a', 1_100), true);
  });

  it('cooldowns', () => {
    const c = new Cooldowns();
    assert.equal(c.take('k', 1000, 0), 0);
    assert.equal(c.take('k', 1000, 400), 600);
    assert.equal(c.take('k', 1000, 1001), 0);
  });
});

describe('variables', () => {
  beforeEach(() => freshDatabase());

  it('remplace les variables connues et laisse les autres', () => {
    const guild = { id: GUILD, name: 'Ma Communauté', memberCount: 150, premiumSubscriptionCount: 3 } as never;
    const user = { id: '42', username: 'pseudo', globalName: 'Pseudo', createdTimestamp: 0 } as never;
    const out = renderTemplate('{mention} {username} {server} {membercount} {boosts} {inconnue} {streamer}', { guild, user, extra: { streamer: 'Zerator' } });
    assert.equal(out, '<@42> pseudo Ma Communauté 150 3 {inconnue} Zerator');
  });
});
