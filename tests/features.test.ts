import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { get, run } from '../src/database/db';
import { defaultConfig, updateConfig } from '../src/core/guildConfig';
import { findBannedWord } from '../src/services/badwords';
import { capsRatio, checkContent, forbiddenLink, hasInvite, isAllowedDomain } from '../src/services/automodRules';
import { checkEligibility, describeRequirements, pickWinners } from '../src/services/giveaways';
import { activeWarnings, countWarnings, formatAutoActions, parseAutoActions } from '../src/services/moderation';
import { accessRoles, categoryOf } from '../src/services/tickets';
import { addXp, getXp, leaderboard, levelFromXp, rankOf, setXp, totalXpForLevel, xpToNext } from '../src/services/xp';
import { addCoins, buy, transfer, wallet } from '../src/services/economy';
import { grantBadge, listBadges, revokeBadge, userBadges } from '../src/services/badges';
import { grantAutoroles } from '../src/services/autorole';
import { splitReminder } from '../src/modules/reminders';
import { isBirthdayToday, isValidBirthday } from '../src/modules/birthdays';
import { parseMilestones, parseQuests } from '../src/modules/quests';
import { parseSections } from '../src/modules/rules';
import { parseQuestions } from '../src/modules/forms';
import { matches } from '../src/modules/autoresponses';
import { countAction } from '../src/modules/antinuke';
import { freshDatabase, GUILD, OTHER, USER } from './helpers';

describe('avertissements', () => {
  beforeEach(() => freshDatabase());

  it('compte les warns actifs par membre et par serveur', () => {
    for (let i = 0; i < 3; i++) run('INSERT INTO warnings (guild_id, user_id, moderator_id, reason, created_at) VALUES (?, ?, ?, ?, ?)', GUILD, USER, OTHER, `r${i}`, i);
    run('INSERT INTO warnings (guild_id, user_id, moderator_id, reason, created_at) VALUES (?, ?, ?, ?, ?)', 'autre', USER, OTHER, 'x', 9);
    run('UPDATE warnings SET active = 0 WHERE reason = ?', 'r0');
    assert.equal(countWarnings(GUILD, USER), 2);
    assert.deepEqual(activeWarnings(GUILD, USER).map((w) => w.reason), ['r1', 'r2']);
  });

  it('lit et réécrit les actions automatiques', () => {
    const parsed = parseAutoActions('5:kick, 3:timeout:60, 7:ban');
    assert.deepEqual(parsed, [
      { warns: 3, action: 'timeout', durationMinutes: 60 },
      { warns: 5, action: 'kick', durationMinutes: 0 },
      { warns: 7, action: 'ban', durationMinutes: 0 },
    ]);
    assert.equal(formatAutoActions(parsed!), '3:timeout:60, 5:kick, 7:ban');
    assert.equal(parseAutoActions('3:mute'), null);
    assert.deepEqual(parseAutoActions(''), []);
  });
});

describe('giveaways', () => {
  it('tire des gagnants distincts parmi les participants', () => {
    const pool = ['a', 'b', 'c', 'd', 'e'];
    for (let i = 0; i < 50; i++) {
      const winners = pickWinners(pool, 3);
      assert.equal(winners.length, 3);
      assert.equal(new Set(winners).size, 3);
      assert.ok(winners.every((w) => pool.includes(w)));
    }
    assert.deepEqual(pickWinners(['x'], 5), ['x']);
    assert.deepEqual(pickWinners([], 2), []);
  });

  it('vérifie les conditions de participation', () => {
    freshDatabase();
    const now = Date.now();
    const member = (roles: string[], createdDaysAgo: number, joinedDaysAgo: number) =>
      ({ id: USER, guild: { id: GUILD }, roles: { cache: new Map(roles.map((r) => [r, true])) }, user: { createdTimestamp: now - createdDaysAgo * 86_400_000 }, joinedTimestamp: now - joinedDaysAgo * 86_400_000 }) as never;
    assert.equal(checkEligibility(member([], 10, 10), {}), null);
    assert.match(checkEligibility(member([], 10, 10), { roleId: 'vip' }) ?? '', /rôle/);
    assert.equal(checkEligibility(member(['vip'], 10, 10), { roleId: 'vip' }), null);
    assert.match(checkEligibility(member([], 2, 10), { minAccountDays: 7 }) ?? '', /compte/);
    assert.match(checkEligibility(member([], 30, 1), { minMemberDays: 7 }) ?? '', /serveur/);
    assert.match(checkEligibility(member([], 30, 30), { minLevel: 5 }) ?? '', /niveau/);
    setXp(GUILD, USER, totalXpForLevel(5));
    assert.equal(checkEligibility(member([], 30, 30), { minLevel: 5 }), null);
    assert.equal(describeRequirements({ roleId: 'r', minLevel: 3, note: 'Suivre la chaîne' }).length, 3);
  });
});

describe('tickets', () => {
  beforeEach(() => freshDatabase());

  it('résout les rôles qui voient un ticket (catégorie > staff > rôles d’accès)', () => {
    const roles = new Map([['cat', {}], ['staff', {}], ['support', {}]]);
    const guild = { id: GUILD, roles: { cache: roles } } as never;
    updateConfig(GUILD, (c) => {
      c.permissions.support = ['support'];
    });
    const cat = categoryOf(GUILD, 'support');
    assert.deepEqual(accessRoles(guild, cat), ['support']);
    updateConfig(GUILD, (c) => void (c.tickets.staffRoles = ['staff', 'supprime']));
    assert.deepEqual(accessRoles(guild, cat), ['staff']);
    assert.deepEqual(accessRoles(guild, { ...cat, roles: ['cat'] }), ['cat', 'staff']);
  });

  it('garde un motif par défaut pour une catégorie inconnue', () => {
    assert.equal(categoryOf(GUILD, 'disparue').label, 'disparue');
    assert.equal(defaultConfig().tickets.categories.length >= 4, true);
  });
});

describe('rappels', () => {
  it('sépare la durée du texte', () => {
    assert.deepEqual(splitReminder('2h30 live Twitch'), { delay: 9_000_000, text: 'live Twitch' });
    assert.deepEqual(splitReminder('1j 2h test'), { delay: 93_600_000, text: 'test' });
    assert.equal(splitReminder('sans durée'), null);
  });
});

describe('XP et niveaux', () => {
  beforeEach(() => freshDatabase());

  it('formule de niveau cohérente', () => {
    assert.equal(xpToNext(0), 100);
    assert.equal(totalXpForLevel(2), 100 + 155);
    assert.deepEqual(levelFromXp(99), { level: 0, current: 99, needed: 100 });
    assert.deepEqual(levelFromXp(255), { level: 2, current: 0, needed: 220 });
  });

  it('ajoute de l’XP, détecte les passages de niveau et classe', () => {
    assert.deepEqual(addXp(GUILD, USER, 120), { oldLevel: 0, newLevel: 1, xp: 120 });
    addXp(GUILD, OTHER, 50);
    assert.equal(rankOf(GUILD, USER), 1);
    assert.equal(rankOf(GUILD, OTHER), 2);
    assert.equal(addXp(GUILD, USER, -1000).xp, 0, 'jamais négatif');
    assert.deepEqual(leaderboard(GUILD).map((r) => r.user_id), [OTHER]);
    assert.equal(getXp(GUILD, 'inconnu').xp, 0);
  });
});

describe('économie et badges', () => {
  beforeEach(() => freshDatabase());

  it('refuse un solde négatif et transfère de façon atomique', () => {
    addCoins(GUILD, USER, 100);
    assert.throws(() => transfer(GUILD, USER, OTHER, 500));
    assert.equal(wallet(GUILD, USER).balance, 100);
    transfer(GUILD, USER, OTHER, 40);
    assert.equal(wallet(GUILD, USER).balance, 60);
    assert.equal(wallet(GUILD, OTHER).balance, 40);
  });

  it('achète en boutique avec stock', () => {
    run("INSERT INTO shop_items (guild_id, name, price, type, stock, created_at) VALUES (?, 'Ticket', 30, 'item', 1, 0)", GUILD);
    const item = get<never>('SELECT * FROM shop_items')!;
    addCoins(GUILD, USER, 100);
    assert.equal(buy(GUILD, USER, item), 70);
    assert.throws(() => buy(GUILD, USER, item), /stock/);
    assert.equal(wallet(GUILD, USER).balance, 70);
  });

  it('donne des badges par défaut sans doublon', () => {
    assert.ok(listBadges(GUILD).length >= 8);
    assert.equal(grantBadge(GUILD, USER, 'og'), true);
    assert.equal(grantBadge(GUILD, USER, 'og'), false);
    assert.equal(grantBadge(GUILD, USER, 'inexistant'), false);
    assert.deepEqual(userBadges(GUILD, USER).map((b) => b.badge_id), ['og']);
    assert.equal(revokeBadge(GUILD, USER, 'og'), true);
  });
});

describe('rôles automatiques', () => {
  beforeEach(() => freshDatabase());

  it('ne donne que les rôles gérables par le bot', async () => {
    const added: string[][] = [];
    const botTop = { comparePositionTo: (r: { position: number }) => 10 - r.position };
    const roles = new Map<string, { id: string; position: number; managed: boolean }>([
      ['bas', { id: 'bas', position: 1, managed: false }],
      ['haut', { id: 'haut', position: 50, managed: false }],
      ['integration', { id: 'integration', position: 2, managed: true }],
    ]);
    const guild = {
      id: GUILD,
      roles: { cache: roles },
      members: { me: { permissions: { has: () => true }, roles: { highest: botTop } } },
      channels: { cache: new Map() },
    };
    const member = {
      id: USER,
      guild,
      roles: { cache: new Map(), add: async (list: { id: string }[]) => void added.push(list.map((r) => r.id)) },
    };
    updateConfig(GUILD, (c) => void (c.autorole.memberRoles = ['bas', 'haut', 'integration', 'supprime']));
    const given = await grantAutoroles(member as never, 'member');
    assert.deepEqual(given, ['bas']);
    assert.deepEqual(added, [['bas']]);
  });
});

describe('automod', () => {
  it('détecte les invitations et les liens hors whitelist', () => {
    assert.equal(hasInvite('rejoins discord.gg/abc'), true);
    assert.equal(hasInvite('https://discord.com/invite/xyz'), true);
    assert.equal(hasInvite('discord.com/channels/1/2'), false);
    assert.equal(isAllowedDomain('clips.twitch.tv', ['twitch.tv']), true);
    assert.equal(isAllowedDomain('twitch.tv.evil.com', ['twitch.tv']), false);
    assert.equal(forbiddenLink('https://www.youtube.com/watch?v=1 et https://evil.com', ['youtube.com']), 'evil.com');
  });

  it('mots interdits résistants aux contournements, sans faux positifs', () => {
    assert.equal(findBannedWord(['pute'], 'espèce de p.u.t.3'), 'pute');
    assert.equal(findBannedWord(['negre'], 'un n3gr3'), 'negre');
    assert.equal(findBannedWord(['negre'], 'un cocktail negroni'), null);
    assert.equal(findBannedWord(['pute'], 'mon computer et ma réputation'), null);
  });

  it('majuscules et mentions', () => {
    assert.ok(capsRatio('BONJOUR TOUT LE MONDE').ratio > 0.9);
    const cfg = { ...defaultConfig().automod, caps: { enabled: true, percent: 70, minLength: 10 } };
    assert.equal(checkContent(cfg, 'ARRÊTEZ DE CRIER SVP', 0, false)?.rule, 'caps');
    assert.equal(checkContent(cfg, 'salut', 10, false)?.rule, 'mentions');
    assert.equal(checkContent(cfg, 'salut à tous', 1, false), null);
  });
});

describe('parseurs des modules', () => {
  it('anniversaires', () => {
    assert.equal(isValidBirthday(29, 2), true);
    assert.equal(isValidBirthday(31, 4), false);
    assert.equal(isBirthdayToday({ day: 29, month: 2 }, { day: 28, month: 2, year: 2027 }), true, 'fêté le 28 les années non bissextiles');
    assert.equal(isBirthdayToday({ day: 29, month: 2 }, { day: 28, month: 2, year: 2028 }), false);
  });

  it('quêtes et paliers', () => {
    assert.equal(parseQuests('messages:20:100:50:Envoyer 20 messages\nvoice_minutes:30:0:10:Vocal')?.length, 2);
    assert.equal(parseQuests('inconnu:1:1:1:x'), null);
    assert.deepEqual(parseMilestones('30:1000:1000, 7:200:200')?.map((m) => m.days), [7, 30]);
  });

  it('règlement, formulaires et auto-réponses', () => {
    assert.deepEqual(parseSections('## Respect\nSois gentil\n\n## Pub\nInterdite'), [
      { title: 'Respect', content: 'Sois gentil' },
      { title: 'Pub', content: 'Interdite' },
    ]);
    assert.deepEqual(parseQuestions('Âge\nMotivation*\n?Portfolio'), [
      { label: 'Âge', long: false, required: true },
      { label: 'Motivation', long: true, required: true },
      { label: 'Portfolio', long: false, required: false },
    ]);
    assert.equal(matches({ trigger: 'youtube', match_type: 'contains' }, 'ta chaîne YouTube ?'), true);
    assert.equal(matches({ trigger: 'yt', match_type: 'word' }, 'mayte'), false);
    assert.equal(matches({ trigger: 'réseaux', match_type: 'exact' }, 'Reseaux'), true);
  });

  it('anti-nuke compte les actions dans la fenêtre', () => {
    assert.equal(countAction('k', 1000, 0), 1);
    assert.equal(countAction('k', 1000, 500), 2);
    assert.equal(countAction('k', 1000, 2000), 1);
  });
});
