import {
  welcomeScreen, menuScreen, profileScreen, productsScreen, errorScreen,
  topUpScreen, topUpMethodScreen, purchasesScreen, purchaseConfirmScreen,
  purchaseCompleteScreen, insufficientFundsText, changedPriceText, purchaseFailedText,
} from '../ui/screens.js';
import { answerCallback } from './transport.js';
import { isTopUpAmount } from './top-up-options.js';
export function registerHandlers(bot, { store, transport, rulesVersion, channels = {}, hooks = {}, logger = console }) {
  const hasAgreement = record => Boolean(record?.acceptedAt && record.rulesVersion === rulesVersion);
  const purchasedProductIds = userId => store.listPurchasedProductIds?.(userId) ?? [];
  const hasPurchasedProduct = (userId, productId) => store.hasPurchasedProduct?.(userId, productId) ?? false;
  async function requireAgreement(ctx) {
    const record = store.get(ctx.from.id);
    if (hasAgreement(record)) return record;
    await answerCallback(ctx, 'Сначала подтвердите возраст и согласие с правилами.');
    await transport.show(ctx, welcomeScreen());
    return null;
  }
  bot.use(async (ctx, next) => {
    // pre_checkout_query (оплата Stars) приходит без chat: пропускаем к обработчику платежей.
    if (ctx.preCheckoutQuery) return next();
    if (ctx.chat?.type !== 'private' || !ctx.from) {
      if (ctx.callbackQuery) await answerCallback(ctx, 'Откройте личный чат с ботом.');
      else if (ctx.message?.text?.startsWith('/start')) await ctx.reply(
        'Night Kavkaz работает в личных сообщениях. Откройте чат со мной и нажмите /start.');
      return;
    }
    // Save the latest Telegram profile and first-seen date for the admin user directory.
    store.updateUserProfile(ctx.from);
    return next();
  });
  bot.start(ctx => {
    hooks.onStart?.(ctx);
    return transport.reply(ctx, hasAgreement(store.get(ctx.from.id)) ? menuScreen(ctx.from, store.isAdmin(ctx.from.id)) : welcomeScreen());
  });
  bot.action('accept_rules', async ctx => {
    await answerCallback(ctx);
    store.accept(ctx.from.id, rulesVersion);
    await transport.show(ctx, menuScreen(ctx.from, store.isAdmin(ctx.from.id)));
  });
  bot.action('main_menu', async ctx => {
    if (!(await requireAgreement(ctx))) return;
    await answerCallback(ctx);
    await transport.show(ctx, menuScreen(ctx.from, store.isAdmin(ctx.from.id)));
  });
  async function showProducts(ctx) {
    if (!(await requireAgreement(ctx))) return;
    await answerCallback(ctx);
    await transport.show(ctx, productsScreen(store.listProducts(), purchasedProductIds(ctx.from.id)));
  }
  bot.action('products', ctx => showProducts(ctx));
  bot.action(/^product:(\d{1,15})$/, async ctx => {
    if (!(await requireAgreement(ctx))) return;
    const product = store.getProduct(Number(ctx.match[1]));
    if (product && hasPurchasedProduct(ctx.from.id, product.id)) {
      await answerCallback(ctx, 'Вы уже приобрели этот товар. Повторная покупка недоступна.');
      await transport.show(ctx, productsScreen(store.listProducts(), purchasedProductIds(ctx.from.id)));
      return;
    }
    await answerCallback(ctx);
    const record = store.get(ctx.from.id);
    await transport.show(ctx, purchaseConfirmScreen(product, record?.balance ?? 0));
  });
  async function notifyAdmins(ctx, text) {
    for (const target of store.listAdmins()) {
      try { await ctx.telegram.sendMessage(target.telegramId, text); } catch { /* админ мог не открыть бота */ }
    }
  }
  async function failPurchase(ctx, reason, productTitle) {
    logger.error('Не удалось выдать ссылку на канал.', { reason, productTitle });
    await answerCallback(ctx, purchaseFailedText(), { show_alert: true });
    await transport.show(ctx, productsScreen(store.listProducts(), purchasedProductIds(ctx.from.id)));
    await notifyAdmins(ctx, `Покупка «${productTitle}» не прошла: ${reason}. Деньги пользователю ${ctx.from.id} не списаны.`);
  }
  bot.action(/^confirm_purchase:(\d{1,15}):(\d{1,16})$/, async ctx => {
    if (!(await requireAgreement(ctx))) return;
    const productId = Number(ctx.match[1]);
    const product = store.getProduct(productId);
    const channelId = product?.slug ? channels[product.slug] : undefined;
    if (product && !channelId) {
      await failPurchase(ctx, 'для товара не указан ID канала в .env', product.title);
      return;
    }
    const result = store.purchaseProduct(
      ctx.from.id,
      productId,
      ctx.callbackQuery.id,
      Number(ctx.match[2]),
    );
    if (result.status === 'insufficient_funds') {
      await answerCallback(ctx, insufficientFundsText(result), { show_alert: true });
      return;
    }
    if (result.status === 'unavailable') {
      await answerCallback(ctx, 'Товар больше недоступен.', { show_alert: true });
      await transport.show(ctx, productsScreen(store.listProducts(), purchasedProductIds(ctx.from.id)));
      return;
    }
    if (result.status === 'user_not_found') {
      await answerCallback(ctx, 'Не удалось найти ваш профиль. Отправьте /start.', { show_alert: true });
      return;
    }
    if (result.status === 'already_owned') {
      await answerCallback(ctx, 'Вы уже приобрели этот товар. Повторная покупка недоступна.', { show_alert: true });
      await transport.show(ctx, productsScreen(store.listProducts(), purchasedProductIds(ctx.from.id)));
      return;
    }
    if (result.status === 'already_processed') {
      await answerCallback(ctx, 'Эта покупка уже обработана.', { show_alert: true });
      return;
    }
    if (result.status === 'price_changed') {
      const product = store.getProduct(result.productId);
      await answerCallback(ctx, changedPriceText(), { show_alert: true });
      await transport.show(ctx, purchaseConfirmScreen(product, result.balance));
      return;
    }
    // Деньги списаны, покупка в статусе pending. Создаём одноразовую ссылку или откатываем покупку.
    const purchaseChannelId = channels[result.productSlug] ?? channelId;
    let inviteLink;
    try {
      const invite = await ctx.telegram.createChatInviteLink(purchaseChannelId, {
        member_limit: 1,
        name: `Покупка №${result.purchaseId}`.slice(0, 32),
      });
      inviteLink = invite?.invite_link;
      if (!inviteLink) throw new Error('empty invite link');
    } catch (error) {
      store.revertPurchase(result.purchaseId);
      await failPurchase(ctx, `Telegram не создал ссылку (${error.response?.description ?? error.message}). ` +
        'Проверьте, что бот админ канала с правом приглашать', result.productTitle);
      return;
    }
    if (!store.completePurchase(result.purchaseId, inviteLink)) {
      try { await ctx.telegram.revokeChatInviteLink(purchaseChannelId, inviteLink); } catch { /* не критично */ }
      await answerCallback(ctx, purchaseFailedText(), { show_alert: true });
      return;
    }
    await answerCallback(ctx, 'Оплата прошла!');
    await transport.show(ctx, purchaseCompleteScreen({ ...result, inviteLink }));
  });
  bot.action('profile', async ctx => {
    const record = await requireAgreement(ctx);
    if (!record) return;
    await answerCallback(ctx);
    await transport.show(ctx, profileScreen(ctx.from, record));
  });
  bot.action('top_up', async ctx => {
    const record = await requireAgreement(ctx);
    if (!record) return;
    await answerCallback(ctx);
    await transport.show(ctx, topUpScreen(record));
  });
  bot.action(/^top_up_amount:(\d{1,9})$/, async ctx => {
    const record = await requireAgreement(ctx);
    if (!record) return;
    const amount = Number(ctx.match[1]);
    if (!isTopUpAmount(amount)) {
      await answerCallback(ctx, 'Эта сумма недоступна. Выберите сумму из списка.');
      await transport.show(ctx, topUpScreen(record));
      return;
    }
    await answerCallback(ctx);
    await transport.show(ctx, topUpMethodScreen(record, amount));
  });
  async function showPurchases(ctx, page = 0) {
    if (!(await requireAgreement(ctx))) return;
    await answerCallback(ctx);
    await transport.show(ctx, purchasesScreen(store.listPurchases(ctx.from.id, page), page));
  }
  bot.action('my_purchases', ctx => showPurchases(ctx));
  bot.action(/^my_purchases:(\d{1,6})$/, ctx => showPurchases(ctx, Number(ctx.match[1])));
  bot.catch(async (error, ctx) => {
    // Не выводим объект Telegraf целиком: он может содержать токен и персональные данные.
    console.error('Ошибка обработки обновления.', { code: error.response?.error_code ?? error.code ?? 'UNKNOWN' });
    try {
      if (ctx.callbackQuery) { await answerCallback(ctx); await transport.show(ctx, errorScreen()); }
      else await transport.reply(ctx, errorScreen());
    } catch { console.error('Не удалось отправить сообщение об ошибке.'); }
  });
}