import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
// slug товара -> переменная окружения с ID канала.
export const CHANNEL_ENV = Object.freeze({
  'dagestan-private': 'CHANNEL_DAGESTAN_ID',
  'ingush-private': 'CHANNEL_INGUSH_ID',
  'chechen-private': 'CHANNEL_CHECHEN_ID',
  covered: 'CHANNEL_COVERED_ID',
  everything: 'CHANNEL_EVERYTHING_ID',
});
function readChannels(env) {
  const channels = {};
  for (const [slug, name] of Object.entries(CHANNEL_ENV)) {
    const value = env[name]?.trim();
    if (!value) continue;
    if (!/^-100\d{5,20}$/.test(value)) throw new Error(`${name} должен быть ID канала вида -1001234567890.`);
    channels[slug] = value;
  }
  return Object.freeze(channels);
}
function readCard(env) {
  const raw = env.MONEY_ACCEPT_CARD?.trim();
  if (!raw) return null;
  const digits = raw.replace(/[\s-]/g, '');
  if (!/^\d{11,20}$/.test(digits)) throw new Error('MONEY_ACCEPT_CARD должен содержать только номер карты или счёта (цифры).');
  return digits;
}
export function readConfig(env = process.env) {
  const token = env.BOT_TOKEN?.trim();
  if (!token || token === 'your_telegram_bot_token_here') throw new Error('Укажите BOT_TOKEN в .env.');
  const file = env.DATABASE_PATH?.trim() || 'data/bot.sqlite';
  const rawAdminIds = env.ADMIN_IDS?.trim() || '';
  const bootstrapAdminIds = rawAdminIds ? rawAdminIds.split(',').map(value => value.trim()) : [];
  if (bootstrapAdminIds.some(id => !/^[1-9]\d*$/.test(id))) {
    throw new Error('ADMIN_IDS должен содержать Telegram ID через запятую, без имён и @username.');
  }
  return { token, databasePath: isAbsolute(file) ? file : resolve(projectRoot, file),
    legacyPath: resolve(projectRoot, 'data/users.json'), rulesVersion: 1,
    bootstrapAdminIds: [...new Set(bootstrapAdminIds)],
    channels: readChannels(env), moneyAcceptCard: readCard(env) };
}