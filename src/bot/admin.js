import { answerCallback } from './transport.js';
import {
  adminMenuScreen, adminPromptScreen, adminAdminsScreen, adminCountScreen,
  adminLookupScreen, adminCreditResultScreen, adminBroadcastPreviewScreen,
  adminBroadcastResultScreen, adminUsersScreen, adminActionResultScreen,
} from '../ui/admin/screens.js';
import { renderScreen } from '../ui/emoji.js';
import { emoji } from '../ui/emoji.js';

const INPUT_TTL_MS = 10 * 60 * 1000;
const MAX_BROADCAST_LENGTH = 3500;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const validId = value => /^[1-9]\d{0,19}$/.test(value);

export function registerAdminHandlers(bot, { store, transport, clock = Date.now, logger = console }) {
  const inputs = new Map();
  const drafts = new Map();
  const admin = ctx => Boolean(ctx.from && ctx.chat?.type === 'private' && store.isAdmin(ctx.from.id));

  async function deny(ctx) {
    await answerCallback(ctx, 'Доступ только для администраторов.', { show_alert: true });
  }
  async function showMenu(ctx) {
    await transport.show(ctx, adminMenuScreen(store.isMaintenanceMode()));
  }
  async function removeIncomingMessage(ctx) {
    try { await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id); }
    catch { /* Telegram may deny deletion; still deliver the result. */ }
  }
  async function replacePrompt(ctx, state, screen) {
    await removeIncomingMessage(ctx);
    if (state.prompt?.chatId && state.prompt?.messageId && ctx.telegram?.editMessageText) {
      const rendered = renderScreen(screen);
      try {
        await ctx.telegram.editMessageText(state.prompt.chatId, state.prompt.messageId, undefined,
          rendered.text, rendered.extra);
        return;
      } catch (error) {
        if (error.response?.error_code === 400 && /message is not modified/i.test(error.response.description ?? '')) return;
        if (error.response?.error_code === 400 && /custom[_ ]emoji|PREMIUM_ACCOUNT_REQUIRED/i.test(error.response.description ?? '')) {
          try {
            const plain = renderScreen(screen, false);
            await ctx.telegram.editMessageText(state.prompt.chatId, state.prompt.messageId, undefined,
              plain.text, plain.extra);
            return;
          } catch (fallbackError) {
            if (fallbackError.response?.error_code === 400 && /message is not modified/i.test(fallbackError.response.description ?? '')) return;
          }
        }
      }
    }
    await transport.reply(ctx, screen);
  }
  async function startInput(ctx, type, title, instructions, extraState = {}) {
    const message = ctx.callbackQuery?.message;
    const prompt = message ? { chatId: message.chat.id, messageId: message.message_id } : null;
    const state = { type, createdAt: clock(), prompt, ...extraState };
    inputs.set(String(ctx.from.id), state);
    await answerCallback(ctx);
    await transport.show(ctx, adminPromptScreen(title, instructions));
  }
  async function showInputResult(ctx, state, screen) {
    await replacePrompt(ctx, state, screen);
  }

  bot.action('admin_menu', async ctx => {
    if (!admin(ctx)) return deny(ctx);
    inputs.delete(String(ctx.from.id));
    await answerCallback(ctx);
    await showMenu(ctx);
  });
  bot.action('admin_maintenance_toggle', async ctx => {
    if (!admin(ctx)) return deny(ctx);
    inputs.delete(String(ctx.from.id));
    drafts.delete(String(ctx.from.id));
    const enabled = store.setMaintenanceMode(!store.isMaintenanceMode());
    await answerCallback(ctx, enabled ? 'Технические работы включены.' : 'Технические работы выключены.');
    await showMenu(ctx);
  });
  bot.action('admin_cancel', async ctx => {
    if (!admin(ctx)) return deny(ctx);
    inputs.delete(String(ctx.from.id));
    await answerCallback(ctx);
    await showMenu(ctx);
  });
  bot.action('admin_broadcast', async ctx => {
    if (!admin(ctx)) return deny(ctx);
    await startInput(ctx, 'broadcast', 'Новая рассылка',
      'Отправьте текст для зарегистрированных пользователей. Максимум 3500 символов. Перед отправкой будет предпросмотр.');
  });
  bot.action(/^admin_add:(\d{1,6})$/, async ctx => {
    if (!admin(ctx)) return deny(ctx);
    if (!store.isSystemAdmin(ctx.from.id)) return answerCallback(ctx, 'Добавлять администраторов могут только владельцы, указанные в ADMIN_IDS.', { show_alert: true });
    await startInput(ctx, 'add_admin', 'Добавить администратора',
      'Отправьте Telegram ID или username (с @ или без него). Добавить можно только зарегистрированного пользователя.',
      { returnPage: Number(ctx.match[1]) });
  });
  bot.action(/^admin_remove:(\d{1,6})$/, async ctx => {
    if (!admin(ctx)) return deny(ctx);
    if (!store.isSystemAdmin(ctx.from.id)) return answerCallback(ctx, 'Удалять администраторов могут только владельцы, указанные в ADMIN_IDS.', { show_alert: true });
    await startInput(ctx, 'remove_admin', 'Удалить администратора',
      'Отправьте Telegram ID или username администратора, которого нужно удалить. Владельцев из ADMIN_IDS удалить нельзя.',
      { returnPage: Number(ctx.match[1]) });
  });
  // Старые сообщения с кнопкой из прежней версии остаются безопасными.
  bot.action('admin_add', async ctx => {
    if (!admin(ctx)) return deny(ctx);
    if (!store.isSystemAdmin(ctx.from.id)) return answerCallback(ctx, 'Добавлять администраторов могут только владельцы, указанные в ADMIN_IDS.', { show_alert: true });
    await startInput(ctx, 'add_admin', 'Добавить администратора',
      'Отправьте Telegram ID или username (с @ или без него). Добавить можно только зарегистрированного пользователя.',
      { returnPage: 0 });
  });
  async function showAdmins(ctx, page = 0) {
    ctx.state ??= {};
    ctx.state.adminListRouteHandled = true;
    if (!admin(ctx)) return deny(ctx);
    inputs.delete(String(ctx.from.id));
    await answerCallback(ctx);
    await transport.show(ctx, adminAdminsScreen(store.listAdminPage(page, 5), store.isSystemAdmin(ctx.from.id)));
  }
  bot.action(/^admin_admins_goto:(\d{1,6})$/, async ctx => {
    if (!admin(ctx)) return deny(ctx);
    await startInput(ctx, 'page_admins', 'Перейти к странице администраторов',
      'Отправьте номер страницы, начиная с 1.',
      { returnPage: Number(ctx.match[1]) });
  });
  bot.action('admin_list', ctx => showAdmins(ctx));
  // Compatibility aliases for keyboards created by older builds.
  bot.action('admin_admins', ctx => showAdmins(ctx));
  bot.action('admins', ctx => showAdmins(ctx));
  bot.action(/^admin_admins:(\d{1,6})$/, ctx => showAdmins(ctx, Number(ctx.match[1])));
  bot.action(/^admin_admins_refresh:(\d{1,6})$/, async ctx => {
    if (!admin(ctx)) return deny(ctx);
    inputs.delete(String(ctx.from.id));
    await answerCallback(ctx, 'Данные обновлены.');
    await transport.show(ctx, adminAdminsScreen(store.listAdminPage(Number(ctx.match[1]), 5), store.isSystemAdmin(ctx.from.id)));
  });

  async function showUsers(ctx, page = 0, buyersOnly = false) {
    if (!admin(ctx)) return deny(ctx);
    inputs.delete(String(ctx.from.id));
    await answerCallback(ctx);
    const data = buyersOnly ? store.listBuyers(page, 5) : store.listUsers(page, 5);
    await transport.show(ctx, adminUsersScreen(data, buyersOnly));
  }
  bot.action(/^admin_users_goto:(\d{1,6}):(0|1)$/, async ctx => {
    if (!admin(ctx)) return deny(ctx);
    const buyersOnly = ctx.match[2] === '1';
    await startInput(ctx, buyersOnly ? 'page_buyers' : 'page_users',
      buyersOnly ? 'Перейти к странице покупателей' : 'Перейти к странице пользователей',
      'Отправьте номер страницы, начиная с 1.',
      { returnPage: Number(ctx.match[1]), buyersOnly });
  });
  // Legacy callback remains valid for keyboards from older messages.
  bot.action(/^admin_users_goto:(\d{1,6})$/, async ctx => {
    if (!admin(ctx)) return deny(ctx);
    await startInput(ctx, 'page_users', 'Перейти к странице пользователей',
      'Отправьте номер страницы, начиная с 1.', { returnPage: Number(ctx.match[1]), buyersOnly: false });
  });
  bot.action('admin_users', ctx => showUsers(ctx));
  bot.action('admin_buyers', ctx => showUsers(ctx, 0, true));
  bot.action('admin_user_count', ctx => showUsers(ctx));
  bot.action(/^admin_users:(\d{1,6})$/, ctx => showUsers(ctx, Number(ctx.match[1])));
  bot.action(/^admin_buyers:(\d{1,6})$/, ctx => showUsers(ctx, Number(ctx.match[1]), true));
  bot.action(/^admin_users_refresh:(\d{1,6})$/, async ctx => {
    if (!admin(ctx)) return deny(ctx);
    inputs.delete(String(ctx.from.id));
    await answerCallback(ctx, 'Данные обновлены.');
    await transport.show(ctx, adminUsersScreen(store.listUsers(Number(ctx.match[1]), 5), false));
  });
  bot.action(/^admin_buyers_refresh:(\d{1,6})$/, async ctx => {
    if (!admin(ctx)) return deny(ctx);
    inputs.delete(String(ctx.from.id));
    await answerCallback(ctx, 'Данные обновлены.');
    await transport.show(ctx, adminUsersScreen(store.listBuyers(Number(ctx.match[1]), 5), true));
  });
  bot.action('admin_lookup', async ctx => {
    if (!admin(ctx)) return deny(ctx);
    await startInput(ctx, 'lookup', 'Проверить пользователя',
      'Отправьте Telegram ID или username (с @ или без него).');
  });
  bot.action('admin_credit', async ctx => {
    if (!admin(ctx)) return deny(ctx);
    await startInput(ctx, 'credit', 'Выдать баланс',
      'Отправьте Telegram ID или username и сумму в рублях через пробел, например: @username 500 или 123456789 500. Начисление доступно только зарегистрированным пользователям.');
  });
  bot.action('admin_broadcast_cancel', async ctx => {
    if (!admin(ctx)) return deny(ctx);
    drafts.delete(String(ctx.from.id));
    inputs.delete(String(ctx.from.id));
    await answerCallback(ctx, 'Рассылка отменена.');
    await showMenu(ctx);
  });
  bot.action('admin_broadcast_confirm', async ctx => {
    if (!admin(ctx)) return deny(ctx);
    const actor = String(ctx.from.id);
    inputs.delete(actor);
    const draft = drafts.get(actor);
    if (!draft || draft.createdAt + INPUT_TTL_MS < clock()) {
      drafts.delete(actor);
      await answerCallback(ctx, 'Предпросмотр устарел. Создайте рассылку заново.', { show_alert: true });
      await showMenu(ctx);
      return;
    }
    drafts.delete(actor); // Повторное нажатие не начнёт вторую рассылку.
    const recipients = draft.recipients;
    await answerCallback(ctx, 'Рассылка началась.');
    await transport.show(ctx, adminPromptScreen('Рассылка выполняется', `Отправляю сообщения ${recipients.length} зарегистрированным пользователям.`));
    let sent = 0;
    let failed = 0;
    for (const telegramId of recipients) {
      try {
        await ctx.telegram.sendMessage(telegramId, draft.text);
        sent++;
      } catch {
        failed++;
      }
      // Telegram ограничивает частоту исходящих сообщений; отправляем не быстрее 25/с.
      await sleep(40);
    }
    const actorInfo = store.findRegisteredUser(actor);
    const actorName = [actorInfo?.firstName, actorInfo?.lastName].filter(Boolean).join(' ');
    const actorLabel = `Админ ${actor}${actorInfo?.username ? ` (@${actorInfo.username})` : ''}${actorName ? `, ${actorName}` : ''}`;
    const adminNotice = `${actorLabel} использовал рассылку с сообщением:\n\n${draft.text}`;
    for (const target of store.listAdmins()) {
      if (String(target.telegramId) === actor) continue;
      try { await ctx.telegram.sendMessage(target.telegramId, adminNotice); }
      catch { /* Admin notification failure must not change broadcast result. */ }
      await sleep(40);
    }
    await transport.show(ctx, adminBroadcastResultScreen({ sent, failed, total: recipients.length }));
  });

  bot.on('text', async ctx => {
    if (!admin(ctx)) return;
    const actor = String(ctx.from.id);
    const state = inputs.get(actor);
    if (!state) return;
    const text = ctx.message.text.trim();
    if (state.createdAt + INPUT_TTL_MS < clock()) {
      inputs.delete(actor);
      await showInputResult(ctx, state, { parts: ['Срок действия команды истёк. Откройте раздел заново.'], rows: [[{ text: 'Назад', data: 'admin_menu', icon: emoji('back') }]] });
      return;
    }
    if (text.toLowerCase() === '/cancel') {
      inputs.delete(actor);
      if (state.type === 'page_users' || state.type === 'page_buyers') {
        const data = state.buyersOnly ? store.listBuyers(state.returnPage ?? 0, 5) : store.listUsers(state.returnPage ?? 0, 5);
        return await showInputResult(ctx, state, adminUsersScreen(data, Boolean(state.buyersOnly)));
      }
      if (state.type === 'page_admins') return await showInputResult(ctx, state, adminAdminsScreen(store.listAdminPage(state.returnPage ?? 0, 5)));
      await showInputResult(ctx, state, adminMenuScreen(store.isMaintenanceMode()));
      return;
    }
    if (state.type === 'page_users' || state.type === 'page_buyers' || state.type === 'page_admins') {
      const requestedPage = /^[1-9]\d{0,6}$/.test(text) ? Number(text) : NaN;
      const getPage = state.type === 'page_admins' ? page => store.listAdminPage(page, 5)
        : state.type === 'page_buyers' ? page => store.listBuyers(page, 5)
          : page => store.listUsers(page, 5);
      if (!Number.isSafeInteger(requestedPage)) {
        await showInputResult(ctx, state, adminPromptScreen(
          state.type === 'page_admins' ? 'Перейти к странице администраторов'
            : state.type === 'page_buyers' ? 'Перейти к странице покупателей' : 'Перейти к странице пользователей',
          'Введите целый номер страницы от 1 или /cancel.'));
        inputs.set(actor, { ...state, createdAt: clock() });
        return;
      }
      const totalPages = Math.max(1, Math.ceil(getPage(0).total / 5));
      if (requestedPage > totalPages) {
        await showInputResult(ctx, state, adminPromptScreen(
          state.type === 'page_admins' ? 'Перейти к странице администраторов'
            : state.type === 'page_buyers' ? 'Перейти к странице покупателей' : 'Перейти к странице пользователей',
          `Страницы ${requestedPage} нет. Доступны страницы от 1 до ${totalPages}. Введите номер или /cancel.`));
        inputs.set(actor, { ...state, createdAt: clock() });
        return;
      }
      inputs.delete(actor);
      const screen = state.type === 'page_admins'
        ? adminAdminsScreen(getPage(requestedPage - 1))
        : adminUsersScreen(getPage(requestedPage - 1), state.type === 'page_buyers');
      await showInputResult(ctx, state, screen);
      return;
    }
    if (state.type === 'broadcast') {
      if (!text || text.length > MAX_BROADCAST_LENGTH || text.startsWith('/')) {
        await showInputResult(ctx, state, adminPromptScreen('Новая рассылка', `Текст пустой или длиннее ${MAX_BROADCAST_LENGTH} символов. Отправьте обычный текст или /cancel.`));
        return;
      }
      inputs.delete(actor);
      const recipients = store.listOrdinaryUserIds();
      drafts.set(actor, { text, recipients, createdAt: clock() });
      await showInputResult(ctx, state, adminBroadcastPreviewScreen(text, recipients.length));
      return;
    }
    if (state.type === 'add_admin') {
      if (!store.isSystemAdmin(ctx.from.id)) {
        inputs.delete(actor);
        await showInputResult(ctx, state, adminPromptScreen('Недостаточно прав', 'Добавлять администраторов могут только владельцы, указанные в ADMIN_IDS.'));
        return;
      }
      if (!validId(text) && !/^@?[A-Za-z0-9_]{1,32}$/.test(text)) {
        await showInputResult(ctx, state, adminPromptScreen('Добавить администратора', 'Формат не распознан. Отправьте Telegram ID или username (с @ или без него).'));
        return;
      }
      const result = store.addAdmin(text, actor);
      inputs.delete(actor);
      if (result.status === 'added') {
        const notification = {
          parts: [emoji('lock'), ' ', { type: 'bold', text: 'Вас назначили администратором Night Kavkaz.' }, '\n\n',
            emoji('check'), ' Теперь вам доступна админ-панель бота.'],
          rows: [[{ text: 'Открыть панель администратора', data: 'admin_menu', icon: emoji('lock') }]],
        };
        const rendered = renderScreen(notification);
        try { await ctx.telegram.sendMessage(result.telegramId, rendered.text, rendered.extra); }
        catch (error) {
          if (error.response?.error_code === 400 && /custom[_ ]emoji|PREMIUM_ACCOUNT_REQUIRED/i.test(error.response.description ?? '')) {
            try { const plain = renderScreen(notification, false); await ctx.telegram.sendMessage(result.telegramId, plain.text, plain.extra); } catch { /* User may not have opened the bot yet. */ }
          }
        }
      }
      const message = result.status === 'added'
        ? `Администратор ${result.telegramId} добавлен. Уведомление отправлено, если пользователь уже открыл бота.`
        : result.status === 'already_admin' ? `Пользователь ${result.telegramId} уже есть в списке администраторов.`
          : result.status === 'not_found' ? `Пользователь ${text} не зарегистрирован в базе данных. Администратор не добавлен.`
            : 'Недостаточно прав. Изменения не внесены.';
      await showInputResult(ctx, state, adminActionResultScreen(message));
      return;
    }
    if (state.type === 'remove_admin') {
      if (!store.isSystemAdmin(ctx.from.id)) {
        inputs.delete(actor);
        await showInputResult(ctx, state, adminPromptScreen('Недостаточно прав', 'Удалять администраторов могут только владельцы, указанные в ADMIN_IDS.'));
        return;
      }
      if (!validId(text) && !/^@?[A-Za-z0-9_]{1,32}$/.test(text)) {
        await showInputResult(ctx, state, adminPromptScreen('Удалить администратора', 'Формат не распознан. Отправьте Telegram ID или username.'));
        inputs.set(actor, { ...state, createdAt: clock() });
        return;
      }
      const result = store.removeAdmin(text, actor);
      const messages = {
        removed: `Администратор ${result.telegramId} удалён.`,
        not_admin: `Администратор ${text} не найден.`,
        system_admin: `Нельзя удалить владельца ${result.telegramId}, указанного в ADMIN_IDS.`,
        forbidden: 'Недостаточно прав. Изменения не внесены.',
      };
      inputs.delete(actor);
      await showInputResult(ctx, state, adminActionResultScreen(
        messages[result.status] ?? 'Не удалось удалить администратора.'));
      return;
    }
    if (state.type === 'lookup') {
      const validLookup = validId(text) || /^@?[A-Za-z0-9_]{1,32}$/.test(text);
      if (!validLookup) {
        await showInputResult(ctx, state, adminPromptScreen('Проверить пользователя', 'Формат не распознан. Отправьте Telegram ID или username (с @ или без него).'));
        return;
      }
      inputs.delete(actor);
      await showInputResult(ctx, state, adminLookupScreen(store.findRegisteredUser(text), text));
      return;
    }
    if (state.type === 'credit') {
      const match = text.match(/^(@?[A-Za-z0-9_]{1,32}|[1-9]\d{0,19})\s+([1-9]\d{0,11})$/);
      if (!match) {
        await showInputResult(ctx, state, adminPromptScreen('Выдать баланс', 'Формат: ID или @username и целая сумма в рублях через пробел, например @username 500 или 123456789 500.'));
        return;
      }
      const amount = Number(match[2]);
      if (!Number.isSafeInteger(amount) || amount < 1) {
        await showInputResult(ctx, state, adminPromptScreen('Выдать баланс', 'Сумма вне допустимого диапазона. Введите меньшую сумму или /cancel.'));
        return;
      }
      inputs.delete(actor);
      const result = store.creditUser(actor, match[1], amount);
      await showInputResult(ctx, state, adminCreditResultScreen({ ...result, query: match[1], telegramId: result.telegramId ?? match[1] }));
    }
  });
  // Register catch-all last, or it would consume admin callbacks before their handlers.
  bot.on('callback_query', async ctx => {
    const data = ctx.callbackQuery?.data;
    if (!ctx.state.adminListRouteHandled && ['admin_list', 'admin_admins', 'admins'].includes(data)) {
      return showAdmins(ctx);
    }
    return answerCallback(ctx, 'Кнопка устарела. Откройте нужный раздел заново.');
  });
}