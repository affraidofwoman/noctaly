import { all, get, run, transaction } from '../database/db';
import { recordLog } from '../core/logService';

export interface Wallet {
  balance: number;
  total_earned: number;
  last_daily: number;
  daily_streak: number;
}

export function wallet(guildId: string, userId: string): Wallet {
  return (
    get<Wallet>('SELECT balance, total_earned, last_daily, daily_streak FROM economy WHERE guild_id = ? AND user_id = ?', guildId, userId) ?? {
      balance: 0,
      total_earned: 0,
      last_daily: 0,
      daily_streak: 0,
    }
  );
}

/** Ajoute (ou retire si négatif) des pièces. Refuse de passer sous zéro. Retourne le nouveau solde. */
export function addCoins(guildId: string, userId: string, amount: number, reason = 'gain'): number {
  const value = Math.trunc(amount);
  return transaction(() => {
    const current = wallet(guildId, userId);
    const next = current.balance + value;
    if (next < 0) throw new Error('solde insuffisant');
    run(
      `INSERT INTO economy (guild_id, user_id, balance, total_earned) VALUES (?, ?, ?, ?)
       ON CONFLICT(guild_id, user_id) DO UPDATE SET balance = excluded.balance, total_earned = economy.total_earned + ?`,
      guildId,
      userId,
      next,
      Math.max(0, value),
      Math.max(0, value),
    );
    if (Math.abs(value) >= 1000) recordLog(guildId, 'community', `coins-${reason}`, userId, null, { amount: value });
    return next;
  });
}

export function transfer(guildId: string, from: string, to: string, amount: number): { from: number; to: number } {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('montant invalide');
  return transaction(() => ({ from: addCoins(guildId, from, -amount, 'give'), to: addCoins(guildId, to, amount, 'give') }));
}

export function setDaily(guildId: string, userId: string, at: number, streak: number): void {
  run(
    `INSERT INTO economy (guild_id, user_id, last_daily, daily_streak) VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET last_daily = excluded.last_daily, daily_streak = excluded.daily_streak`,
    guildId,
    userId,
    at,
    streak,
  );
}

export function richest(guildId: string, limit = 100): { user_id: string; balance: number }[] {
  return all('SELECT user_id, balance FROM economy WHERE guild_id = ? AND balance > 0 ORDER BY balance DESC LIMIT ?', guildId, limit);
}

export interface ShopItem {
  id: number;
  guild_id: string;
  name: string;
  description: string;
  emoji: string;
  price: number;
  type: 'role' | 'badge' | 'item';
  value: string | null;
  stock: number | null;
}

export function shopItems(guildId: string): ShopItem[] {
  return all<ShopItem>('SELECT * FROM shop_items WHERE guild_id = ? ORDER BY price', guildId);
}

export function shopItem(guildId: string, id: number): ShopItem | undefined {
  return get<ShopItem>('SELECT * FROM shop_items WHERE guild_id = ? AND id = ?', guildId, id);
}

export function inventory(guildId: string, userId: string): { item_name: string; price: number; bought_at: number }[] {
  return all('SELECT item_name, price, bought_at FROM inventory WHERE guild_id = ? AND user_id = ? ORDER BY bought_at DESC LIMIT 50', guildId, userId);
}

/** Achat atomique : stock, solde et inventaire sont mis à jour ensemble. */
export function buy(guildId: string, userId: string, item: ShopItem): number {
  return transaction(() => {
    const fresh = shopItem(guildId, item.id);
    if (!fresh) throw new Error('article introuvable');
    if (fresh.stock !== null && fresh.stock <= 0) throw new Error('rupture de stock');
    const balance = addCoins(guildId, userId, -fresh.price, 'shop');
    if (fresh.stock !== null) run('UPDATE shop_items SET stock = stock - 1 WHERE id = ?', fresh.id);
    run('INSERT INTO inventory (guild_id, user_id, item_id, item_name, price, bought_at) VALUES (?, ?, ?, ?, ?, ?)', guildId, userId, fresh.id, fresh.name, fresh.price, Date.now());
    return balance;
  });
}
