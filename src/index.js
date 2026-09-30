import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { readConfig } from './config.js';
import { createStore } from './store.js';
import { registerHandlers } from './bot/handlers.js';
import { createTransport } from './bot/transport.js';
import { registerAdminHandlers } from './bot/admin.js';
import { registerPaymentHandlers } from './bot/payments.js';
import { CHANNEL_ENV } from './config.js';
async function main() {
  const config = readConfig();
  const store = await createStore(config.databasePath, { legacyPath: config.legacyPath, bootstrapAdminIds: config.bootstrapAdminIds });
  const bot = new Telegraf(config.token);
  const transport = createTransport();
  const hooks = {};
  for (const [slug, name] of Object.entries(CHANNEL_ENV)) {
    if (!config.channels[slug]) console.warn(`Не указан ${name}: покупка этого товара будет недоступна.`);
  }
  if (!config.moneyAcceptCard) console.warn('Не указан MONEY_ACCEPT_CARD: оплата картой будет недоступна.');
  registerHandlers(bot, { store, rulesVersion: config.rulesVersion, transport, channels: config.channels, hooks });
  // Платежи регистрируются до админки: её обработчик text и catch-all callback идут последними.
  registerPaymentHandlers(bot, { store, transport, rulesVersion: config.rulesVersion,
    moneyAcceptCard: config.moneyAcceptCard, hooks });
  registerAdminHandlers(bot, { store, transport });
  let shuttingDown = false;
  let stopRetry;
  const tryStop = signal => {
    try {
      bot.stop(signal);
      clearInterval(stopRetry);
      stopRetry = undefined;
      return true;
    } catch { return false; }
  };
  const stop = signal => {
    shuttingDown = true;
    // В Telegraf 4.16.3 onLaunch вызывается ДО создания polling.
    // Сигнал во время getMe/deleteWebhook не должен потеряться.
    if (!tryStop(signal) && !stopRetry) {
      stopRetry = setInterval(() => tryStop(signal), 100);
      stopRetry.unref();
    }
  };
  const onSigint = () => stop('SIGINT');
  const onSigterm = () => stop('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    await bot.launch({}, () => {
      console.log('Night Kavkaz: подключение к Telegram установлено. Хранилище: SQLite.');
      if (shuttingDown) stop('shutdown');
    });
  } catch (error) {
    if (!shuttingDown) {
      console.error('Не удалось запустить бота. Проверьте токен, сеть и отсутствие второго экземпляра.',
        { code: error.response?.error_code ?? error.code ?? 'UNKNOWN' });
      process.exitCode = 1;
    }
  } finally {
    clearInterval(stopRetry);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    store.close();
  }
}
main().catch(error => { console.error('Ошибка инициализации:', error.message); process.exitCode = 1; });