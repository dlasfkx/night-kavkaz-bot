import { answerCallback } from './transport.js';
import { isTopUpAmount, starsForRub } from './top-up-options.js';
import {
  welcomeScreen, topUpScreen, cardTopUpScreen, receiptPromptScreen, receiptReminderScreen,
  receiptExpiredScreen, receiptSentScreen, receiptTooManyScreen, topUpApprovedScreen,
  topUpRejectedScreen, starsInvoiceSentScreen, starsCreditedScreen,
} from '../ui/screens.js';
import { topUpAdminCaption, topUpAdminKeyboard } from '../ui/admin/screens.js';

const RECEIPT_TTL_MS = 30 * 60 * 1000;
const MAX_PENDING_CARD_TOP_UPS = 3;
const STARS_PAYLOAD = /^stars:(\d{1,9}):([1-9]\d{0,19})$/;

// Пополнение баланса: банковская карта (проверка чека админом) и Telegram Stars.
export function registerPaymentHandlers(bot, { store, transport, rulesVersion, moneyAcceptCard = null,
  hooks = {}, clock = Date.now, logger = console }) {
  const waitingReceipt = new Map();
  const agreed = id => {
    const record = store.get(id);
    return record?.acceptedAt && record.rulesVersion === rulesVersion ? record : null;
  };
  async function requireAgreement(ctx) {
    const record = agreed(ctx.from.id);
    if (record) return record;
    await answerCallback(ctx, 'Сначала подтвердите возраст и согласие с правилами.');
    await transport.show(ctx, welcomeScreen());
    return null;
  }
  function amountFrom(ctx) {
    const amount = Number(ctx.match[1]);
    return isTopUpAmount(amount) ? amount : null;
  }

  // ---------- Банковская карта ----------
  bot.action(/^top_up_card:(\d{1,9})$/, async ctx => {
    if (!(await requireAgreement(ctx))) return;
    const amount = amountFrom(ctx);
    if (!amount) return answerCallback(ctx, 'Эта сумма недоступна. Выберите сумму из списка.');
    waitingReceipt.delete(String(ctx.from.id));
    await answerCallback(ctx);
    await transport.show(ctx, cardTopUpScreen(amount, moneyAcceptCard));
  });
  bot.action(/^top_up_paid:(\d{1,9})$/, async ctx => {
    if (!(await requireAgreement(ctx))) return;
    const amount = amountFrom(ctx);
    if (!amount || !moneyAcceptCard) return answerCallback(ctx, 'Оплата картой сейчас недоступна.', { show_alert: true });
    waitingReceipt.set(String(ctx.from.id), { amount, createdAt: clock() });
    await answerCallback(ctx);
    await transport.show(ctx, receiptPromptScreen(amount));
  });
  bot.action('top_up_receipt_cancel', async ctx => {
    waitingReceipt.delete(String(ctx.from.id));
    const record = await requireAgreement(ctx);
    if (!record) return;
    await answerCallback(ctx, 'Отменено.');
    await transport.show(ctx, topUpScreen(record));
  });

  function activeReceiptState(userId) {
    const state = waitingReceipt.get(userId);
    if (!state) return null;
    if (state.createdAt + RECEIPT_TTL_MS < clock()) { waitingReceipt.delete(userId); return 'expired'; }
    return state;
  }
  // /start перехватывается раньше, поэтому сброс ожидания чека идёт через общий хук.
  hooks.onStart = ctx => waitingReceipt.delete(String(ctx.from.id));

  async function sendReceiptToAdmins(ctx, topUp) {
    const user = store.findRegisteredUser(String(topUp.telegramId));
    const caption = topUpAdminCaption(topUp, user);
    const extra = { caption, reply_markup: topUpAdminKeyboard(topUp.id) };
    let delivered = 0;
    for (const admin of store.listAdmins()) {
      try {
        const message = topUp.receiptKind === 'photo'
          ? await ctx.telegram.sendPhoto(admin.telegramId, topUp.receiptFileId, extra)
          : await ctx.telegram.sendDocument(admin.telegramId, topUp.receiptFileId, extra);
        store.addTopUpAdminMessage(topUp.id, admin.telegramId, message.message_id);
        delivered++;
      } catch { /* админ мог не открыть бота */ }
    }
    if (!delivered) logger.error('Чек не доставлен ни одному администратору.', { topUpId: topUp.id });
  }
  bot.on(['photo', 'document'], async (ctx, next) => {
    const userId = String(ctx.from.id);
    const state = activeReceiptState(userId);
    if (!state) return next();
    if (state === 'expired') return transport.reply(ctx, receiptExpiredScreen());
    if (!agreed(ctx.from.id)) { waitingReceipt.delete(userId); return transport.reply(ctx, welcomeScreen()); }
    const photo = ctx.message.photo?.at(-1);
    const fileId = photo?.file_id ?? ctx.message.document?.file_id;
    const kind = photo ? 'photo' : 'document';
    const result = store.createCardTopUp(userId, state.amount, fileId, kind, MAX_PENDING_CARD_TOP_UPS);
    waitingReceipt.delete(userId);
    if (result.status === 'too_many') return transport.reply(ctx, receiptTooManyScreen());
    if (result.status !== 'created') return transport.reply(ctx, receiptExpiredScreen());
    await sendReceiptToAdmins(ctx, result.topUp);
    await transport.reply(ctx, receiptSentScreen(result.topUp));
  });
  bot.on('text', async (ctx, next) => {
    const userId = String(ctx.from.id);
    const state = activeReceiptState(userId);
    if (!state) return next();
    if (state === 'expired') return transport.reply(ctx, receiptExpiredScreen());
    if (ctx.message.text.trim().toLowerCase() === '/cancel') {
      waitingReceipt.delete(userId);
      const record = agreed(ctx.from.id);
      return record ? transport.reply(ctx, topUpScreen(record)) : transport.reply(ctx, welcomeScreen());
    }
    return transport.reply(ctx, receiptReminderScreen());
  });

  // Решение администратора по чеку: зелёная «Зачислить» / красная «Отклонить».
  bot.action(/^topup_(approve|reject):(\d{1,15})$/, async ctx => {
    if (!store.isAdmin(ctx.from.id)) {
      return answerCallback(ctx, 'Доступ только для администраторов.', { show_alert: true });
    }
    const topUpId = Number(ctx.match[2]);
    const decision = ctx.match[1] === 'approve' ? 'approved' : 'rejected';
    const result = store.reviewCardTopUp(topUpId, ctx.from.id, decision);
    if (result.status === 'forbidden') return answerCallback(ctx, 'Доступ только для администраторов.', { show_alert: true });
    if (result.status === 'not_found') return answerCallback(ctx, 'Заявка не найдена.', { show_alert: true });
    if (result.status === 'balance_limit') {
      return answerCallback(ctx, 'Зачисление превысит максимальный баланс. Заявка не изменена.', { show_alert: true });
    }
    const topUp = result.topUp;
    const reviewer = store.findRegisteredUser(String(topUp.reviewedBy ?? ctx.from.id));
    const caption = topUpAdminCaption(topUp, store.findRegisteredUser(String(topUp.telegramId)), reviewer);
    const messages = store.listTopUpAdminMessages(topUp.id);
    const current = ctx.callbackQuery.message;
    if (current && !messages.some(m => String(m.chatId) === String(current.chat.id) && m.messageId === current.message_id)) {
      messages.push({ chatId: current.chat.id, messageId: current.message_id });
    }
    for (const { chatId, messageId } of messages) {
      try {
        await ctx.telegram.editMessageCaption(chatId, messageId, undefined, caption, { reply_markup: { inline_keyboard: [] } });
      } catch { /* сообщение могли удалить */ }
    }
    if (result.status === 'already_reviewed') {
      return answerCallback(ctx, topUp.status === 'approved' ? 'Заявка уже зачислена.' : 'Заявка уже отклонена.', { show_alert: true });
    }
    await answerCallback(ctx, decision === 'approved' ? `Зачислено ${topUp.amount} ₽.` : 'Заявка отклонена.');
    try {
      await transport.send(ctx.telegram, topUp.telegramId,
        decision === 'approved' ? topUpApprovedScreen(topUp, result.balance) : topUpRejectedScreen(topUp));
    } catch { logger.warn('Не удалось уведомить пользователя о решении по заявке.', { topUpId: topUp.id }); }
  });

  // ---------- Telegram Stars ----------
  bot.action(/^top_up_stars:(\d{1,9})$/, async ctx => {
    if (!(await requireAgreement(ctx))) return;
    const amount = amountFrom(ctx);
    if (!amount) return answerCallback(ctx, 'Эта сумма недоступна. Выберите сумму из списка.');
    const stars = starsForRub(amount);
    await answerCallback(ctx);
    await transport.show(ctx, starsInvoiceSentScreen(amount));
    await ctx.telegram.sendInvoice(ctx.chat.id, {
      title: 'Пополнение баланса',
      description: `Пополнение баланса Night Kavkaz на ${amount} ₽`,
      payload: `stars:${amount}:${ctx.from.id}`,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: `Пополнение на ${amount} ₽`, amount: stars }],
    });
  });
  function parseStarsPayload(payload) {
    const match = STARS_PAYLOAD.exec(payload ?? '');
    if (!match) return null;
    const amount = Number(match[1]);
    return isTopUpAmount(amount) ? { amount, userId: match[2] } : null;
  }
  bot.on('pre_checkout_query', async ctx => {
    const query = ctx.preCheckoutQuery;
    const parsed = parseStarsPayload(query.invoice_payload);
    const valid = parsed && parsed.userId === String(query.from.id) && query.currency === 'XTR' &&
      query.total_amount === starsForRub(parsed.amount) && Boolean(agreed(query.from.id));
    if (valid) await ctx.answerPreCheckoutQuery(true);
    else await ctx.answerPreCheckoutQuery(false, 'Счёт устарел. Создайте новый в разделе «Пополнить баланс».');
  });
  bot.on('successful_payment', async ctx => {
    const payment = ctx.message.successful_payment;
    if (payment.currency !== 'XTR') return;
    const parsed = parseStarsPayload(payment.invoice_payload);
    if (!parsed || parsed.userId !== String(ctx.from.id)) {
      logger.error('Оплата Stars с некорректным payload.', { chargeId: payment.telegram_payment_charge_id });
      return ctx.reply('Оплата получена, но не распознана. Напишите администратору и укажите время оплаты.');
    }
    const result = store.creditStarsTopUp(ctx.from.id, parsed.amount, payment.total_amount,
      payment.telegram_payment_charge_id);
    if (result.status === 'credited') return transport.reply(ctx, starsCreditedScreen(result));
    if (result.status === 'already_processed') return;
    logger.error('Не удалось зачислить оплату Stars.', { status: result.status, chargeId: payment.telegram_payment_charge_id });
    return ctx.reply('Оплата получена, но зачислить её автоматически не удалось. Напишите администратору.');
  });
}