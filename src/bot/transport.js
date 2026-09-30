import { renderScreen } from '../ui/emoji.js';
export function createTransport({ customEmojiEnabled = true, logger = console } = {}) {
  let useCustomEmoji = customEmojiEnabled;
  const unchanged = error => error.response?.error_code === 400 &&
    error.response.description?.includes('message is not modified');
  async function deliver(ctx, screen, edit) {
    async function send() {
      const { text, extra } = renderScreen(screen, useCustomEmoji);
      return edit ? ctx.editMessageText(text, extra) : ctx.reply(text, extra);
    }
    try { return await send(); }
    catch (error) {
      if (unchanged(error)) return;
      // Только явный отказ в кастомных эмодзи, не сетевой сбой.
      if (useCustomEmoji && error.response?.error_code === 400 &&
          /custom[_ ]emoji|PREMIUM_ACCOUNT_REQUIRED/i.test(error.response.description ?? '')) {
        useCustomEmoji = false;
        logger.warn('Telegram отклонил кастомные эмодзи. Используются резервные значки из нового набора.');
        try { return await send(); }
        catch (retryError) { if (unchanged(retryError)) return; throw retryError; }
      }
      throw error;
    }
  }
  // Отправка в произвольный чат (уведомления пользователю и админам).
  async function sendTo(telegram, chatId, screen) {
    const attempt = () => {
      const { text, extra } = renderScreen(screen, useCustomEmoji);
      return telegram.sendMessage(chatId, text, extra);
    };
    try { return await attempt(); }
    catch (error) {
      if (useCustomEmoji && error.response?.error_code === 400 &&
          /custom[_ ]emoji|PREMIUM_ACCOUNT_REQUIRED/i.test(error.response.description ?? '')) {
        useCustomEmoji = false;
        logger.warn('Telegram отклонил кастомные эмодзи. Используются резервные значки из нового набора.');
        return attempt();
      }
      throw error;
    }
  }
  return { reply: (ctx, screen) => deliver(ctx, screen, false), show: (ctx, screen) => deliver(ctx, screen, true),
    send: sendTo };
}
export async function answerCallback(ctx, text, extra) {
  try { await ctx.answerCbQuery(text, extra); }
  catch (error) {
    if (error.response?.error_code === 400 &&
        /query is too old|query ID is invalid|QUERY_ID_INVALID/i.test(error.response.description ?? '')) return;
    throw error;
  }
}