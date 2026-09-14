import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { defaultConfig } from '../src/core/guildConfig';
import { computeLevel, type MemberLike } from '../src/core/permissions';
import { PermLevel } from '../src/core/types';
import {
  addToWhitelist,
  canManageWhitelist,
  getWhitelist,
  isWhitelisted,
  listMembers,
  removeFromWhitelist,
  whitelistLevel,
} from '../src/core/whitelists';
import { freshDatabase, GUILD, OTHER, USER } from './helpers';

const base = (over: Partial<MemberLike> = {}): MemberLike => ({
  id: USER,
  guildOwnerId: '999',
  roleIds: [],
  isAdministrator: false,
  canManageGuild: false,
  whitelistLevel: PermLevel.MEMBER,
  isBotOwner: false,
  ...over,
});

describe('niveaux d’accès', () => {
  const perms = { ...defaultConfig().permissions, moderator: ['mod'], staff: ['staff'], support: ['support'], streamer: ['stream'], admin: ['admin'] };

  it('membre par défaut', () => assert.equal(computeLevel(base(), perms), PermLevel.MEMBER));
  it('rôle support', () => assert.equal(computeLevel(base({ roleIds: ['support'] }), perms), PermLevel.SUPPORT));
  it('le rôle le plus haut l’emporte', () => assert.equal(computeLevel(base({ roleIds: ['support', 'mod'] }), perms), PermLevel.MODERATOR));
  it('administrateur Discord = Admin', () => assert.equal(computeLevel(base({ isAdministrator: true }), perms), PermLevel.ADMIN));
  it('propriétaire du serveur = Streamer', () => assert.equal(computeLevel(base({ guildOwnerId: USER }), perms), PermLevel.STREAMER));
  it('rôle streamer', () => assert.equal(computeLevel(base({ roleIds: ['stream'] }), perms), PermLevel.STREAMER));
  it('owner bot au-dessus de tout', () => assert.equal(computeLevel(base({ isBotOwner: true }), perms), PermLevel.BOT_OWNER));
  it('whitelist cumulée avec les rôles', () => assert.equal(computeLevel(base({ roleIds: ['staff'], whitelistLevel: PermLevel.ADMIN }), perms), PermLevel.ADMIN));
});

describe('whitelists', () => {
  beforeEach(() => freshDatabase());

  it('ajoute, liste et retire par serveur', () => {
    assert.equal(addToWhitelist('sys', USER, GUILD, OTHER), true);
    assert.equal(addToWhitelist('sys', USER, GUILD, OTHER), false, 'pas de doublon');
    assert.equal(isWhitelisted('sys', USER, GUILD), true);
    assert.equal(isWhitelisted('sys', USER, 'autre-serveur'), false, 'une whitelist serveur ne fuit pas');
    assert.deepEqual(listMembers('sys', GUILD), [USER]);
    assert.equal(whitelistLevel(USER, GUILD), PermLevel.MODERATOR);
    assert.equal(removeFromWhitelist('sys', USER, GUILD), true);
    assert.equal(isWhitelisted('sys', USER, GUILD), false);
  });

  it('la whitelist owner est globale', () => {
    addToWhitelist('owner', USER, GUILD, OTHER);
    assert.equal(isWhitelisted('owner', USER, 'nimporte'), true);
    assert.equal(whitelistLevel(USER, 'nimporte'), PermLevel.BOT_OWNER);
  });

  it('les accès ciblés ne donnent pas de niveau', () => {
    addToWhitelist('logs', USER, GUILD, OTHER);
    addToWhitelist('giveaway', USER, GUILD, OTHER);
    assert.equal(whitelistLevel(USER, GUILD), PermLevel.MEMBER);
  });

  it('règles de distribution des whitelists', () => {
    const sys = getWhitelist('sys')!;
    const admin = getWhitelist('admin')!;
    const streamer = getWhitelist('streamer')!;
    const owner = getWhitelist('owner')!;
    assert.equal(canManageWhitelist(PermLevel.ADMIN, sys, false, false), true);
    assert.equal(canManageWhitelist(PermLevel.MODERATOR, sys, false, false), false);
    assert.equal(canManageWhitelist(PermLevel.ADMIN, admin, false, false), false);
    assert.equal(canManageWhitelist(PermLevel.STREAMER, admin, false, false), true);
    assert.equal(canManageWhitelist(PermLevel.STREAMER, streamer, false, false), false, 'un streamer whitelisté ne nomme pas d’autres streamers');
    assert.equal(canManageWhitelist(PermLevel.STREAMER, streamer, false, true), true, 'le propriétaire du serveur peut');
    assert.equal(canManageWhitelist(PermLevel.BOT_OWNER, owner, false, false), false, 'seuls les owners du .env gèrent la whitelist owner');
    assert.equal(canManageWhitelist(PermLevel.BOT_OWNER, owner, true, false), true);
  });
});
