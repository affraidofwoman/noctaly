import { closeDatabase, openDatabase } from '../src/database/db';
import { resetConfigCache } from '../src/core/guildConfig';
import { clearModuleCache, registerModules } from '../src/core/moduleManager';
import { clearWhitelistCache } from '../src/core/whitelists';
import { forgetBrands } from '../src/core/brand';
import type { BotModule } from '../src/core/types';

/** Base SQLite en mémoire, neuve pour chaque fichier de test. */
export function freshDatabase(modules: BotModule[] = []): void {
  closeDatabase();
  openDatabase(':memory:');
  resetConfigCache();
  clearModuleCache();
  clearWhitelistCache();
  forgetBrands();
  registerModules(modules);
}

export const GUILD = '100000000000000001';
export const USER = '200000000000000001';
export const OTHER = '200000000000000002';
