import { button, bold, emoji } from '../emoji.js';

const backRow = () => [[button('Назад', 'admin_menu', { icon: 'back' })]];
// Экраны из вкладки «Пользователи» возвращают обратно в неё.
const usersBackRow = () => [[button('Назад', 'admin_users', { icon: 'back' })]];

export function adminMenuScreen(maintenanceMode = false, pendingReceipts = 0) {
  return {
    parts: [
      emoji('lock'), ' ', bold('Панель администратора'),
      '\nУправление ботом и пользователями.',
      '\n\n', ...(maintenanceMode
        ? [emoji('warning'), ' ', bold('Техработы включены: бот закрыт для пользователей.')]
        : [emoji('check'), ' Бот работает в обычном режиме.']),
    ],
    rows: [
      [
        button('Рассылка', 'admin_broadcast', { icon: 'ellipsis' }),
        button(pendingReceipts > 0 ? `Чеки (${pendingReceipts})` : 'Чеки', 'admin_receipts', { icon: 'card' }),
      ],
      [
        button('Администраторы', 'admin_list', { icon: 'lock' }),
        button('Пользователи', 'admin_users', { icon: 'eyes' }),
      ],
      [button(maintenanceMode ? 'Выключить техработы' : 'Включить техработы', 'admin_maintenance_toggle',
        { icon: maintenanceMode ? 'check' : 'warning', style: maintenanceMode ? 'success' : 'danger' })],
      [button('В главное меню', 'main_menu', { icon: 'back' })],
    ],
  };
}

const adminMoney = amount => new Intl.NumberFormat('ru-RU', {
  style: 'currency', currency: 'RUB', minimumFractionDigits: 0, maximumFractionDigits: 0,
}).format(amount);

function displayDate(value) {
  if (!value) return 'нет данных';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `${date.toLocaleString('ru-RU', { timeZone: 'UTC', dateStyle: 'short', timeStyle: 'short' })} UTC`
    : 'нет данных';
}

export function adminUsersScreen({ items, page, pageSize, total, hasPrev, hasNext }, buyersOnly = false) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const parts = [
    emoji('eyes'), ' ', bold(buyersOnly ? 'Покупатели' : 'Пользователи'), '\n',
    emoji('bullet'), ` Всего: ${total}\n`,
    emoji('bullet'), ` Страница ${page + 1} из ${pageCount}\n\n`,
  ];
  if (!items.length) {
    parts.push(buyersOnly ? 'Пока нет пользователей с покупками или положительным балансом.' : 'Пока нет зарегистрированных пользователей.');
  } else {
    items.forEach((user, index) => {
      const ordinal = page * pageSize + index + 1;
      const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'не указано';
      parts.push(
        emoji('star'), ` № ${ordinal}\n`,
        emoji('question'), ` ID: ${user.telegramId}\n`,
        emoji('question'), ` Username: ${user.username ? `@${user.username}` : 'не указан'}\n`,
        emoji('question'), ` Full name: ${fullName}\n`,
        emoji('question'), ` Баланс: ${adminMoney(user.balance)}\n`,
        emoji('question'), ` Покупок: ${user.purchaseCount}\n`,
        emoji('question'), ` Регистрация: ${displayDate(user.registeredAt)}\n`,
      );
      if (user.bannedAt) parts.push(emoji('lock'), ' ', bold('Заблокирован'), '\n');
      if (index < items.length - 1) parts.push('\n────────────\n\n');
    });
  }
  const rows = [];
  const navigation = [];
  const pageRoute = buyersOnly ? 'admin_buyers' : 'admin_users';
  if (hasPrev) navigation.push(button('← Назад', `${pageRoute}:${page - 1}`, { icon: 'back' }));
  if (hasNext) navigation.push(button('Далее →', `${pageRoute}:${page + 1}`));
  if (navigation.length) rows.push(navigation);
  if (pageCount > 1) {
    rows.push([button('Перейти к странице', `admin_users_goto:${page}:${buyersOnly ? 1 : 0}`, { icon: 'question' })]);
  }
  rows.push([
    button(buyersOnly ? 'Показать всех пользователей' : 'Показать покупателей',
      buyersOnly ? 'admin_users:0' : 'admin_buyers:0', { icon: buyersOnly ? 'eyes' : 'cart' }),
  ]);
  rows.push(
    [
      button('Проверить пользователя', 'admin_lookup', { icon: 'question' }),
      button('Выдать баланс', 'admin_credit', { icon: 'diamond' }),
    ],
    [
      button('Забанить', 'admin_ban', { icon: 'cancel', style: 'danger' }),
      button('Разбанить', 'admin_unban', { icon: 'check' }),
    ],
  );
  rows.push(
    [button('Обновить', `${buyersOnly ? 'admin_buyers' : 'admin_users'}_refresh:${page}`, { icon: 'lightning' })],
    [button('Назад', 'admin_menu', { icon: 'back' })],
  );
  return { parts, rows };
}

export function adminActionResultScreen(message) {
  return {
    parts: [emoji(message.includes('удалён') || message.includes('добавлен') ? 'check' : 'warning'),
      ' ', message],
    rows: backRow(),
  };
}

export function adminPromptScreen(title, instructions, cancelData = 'admin_cancel') {
  return {
    parts: [emoji('question'), ' ', bold(title), '\n\n', emoji('bullet'), ' ', instructions],
    rows: [[button('Отмена', cancelData, { icon: 'cancel' })]],
  };
}

export function adminAdminsScreen(data, canManage = false, notice = '') {
  const result = Array.isArray(data)
    ? { items: data.slice(0, 5), page: 0, pageSize: 5, total: data.length, hasPrev: false, hasNext: data.length > 5 }
    : data;
  const { items, page, pageSize, total, hasPrev, hasNext } = result;
  const parts = [emoji('lock'), ' ', bold(`Администраторы (${total})`), '\n',
    emoji('bullet'), ` Страница ${page + 1} из ${Math.max(1, Math.ceil(total / pageSize))}\n\n`];
  if (notice) parts.push(emoji('check'), ' ', notice, '\n\n');
  if (!items.length) parts.push('Список пуст.');
  else items.forEach((admin, index) => {
    const ordinal = page * pageSize + index + 1;
    const fullName = [admin.firstName, admin.lastName].filter(Boolean).join(' ') || 'не указано';
    parts.push(
      emoji('star'), ` № ${ordinal}\n`,
      emoji('question'), ` ID: ${admin.telegramId}\n`,
      emoji('question'), ` Username: ${admin.username ? `@${admin.username}` : 'не указан'}\n`,
      emoji('question'), ` Full name: ${fullName}\n`,
      emoji('question'), ` Регистрация: ${displayDate(admin.registeredAt)}\n`,
      emoji('question'), ` Администратор с: ${displayDate(admin.addedAt)}\n`,
      emoji('question'), ` Добавил: ${admin.addedBy ?? 'системная настройка'}\n`,
      emoji('question'), ` Баланс: ${admin.balance == null ? 'профиль не зарегистрирован' : adminMoney(admin.balance)}\n`,
      emoji('question'), ` Покупок: ${admin.purchaseCount ?? 0}\n`,
    );
    if (index < items.length - 1) parts.push('\n────────────\n\n');
  });
  const rows = [];
  const nav = [];
  if (hasPrev) nav.push(button('← Назад', `admin_admins:${page - 1}`, { icon: 'back' }));
  if (hasNext) nav.push(button('Далее →', `admin_admins:${page + 1}`));
  if (nav.length) rows.push(nav);
  if (Math.max(1, Math.ceil(total / pageSize)) > 1) {
    rows.push([button('Перейти к странице', `admin_admins_goto:${page}`, { icon: 'question' })]);
  }
  if (canManage) {
    rows.push(
      [button('Добавить администратора', `admin_add:${page}`, { icon: 'profile' })],
      [button('Удалить администратора', `admin_remove:${page}`, { icon: 'cancel' })],
    );
  }
  rows.push([button('Обновить', `admin_admins_refresh:${page}`, { icon: 'lightning' })], ...backRow());
  return { parts, rows };
}

export function adminCountScreen(count) {
  return { parts: [emoji('profile'), ' ', bold('Зарегистрировано пользователей: '), bold(String(count))], rows: backRow() };
}

export function adminLookupScreen(user, query) {
  const parts = [emoji('question'), ' ', bold(`Проверка пользователя: ${query}`), '\n\n'];
  if (!user) parts.push('Такой пользователь не зарегистрирован в базе данных.');
  else {
    const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'не указано';
    parts.push(emoji('check'), ' Зарегистрирован\n');
    parts.push(emoji('question'), ` ID: ${user.telegramId}\n`);
    parts.push(emoji('question'), ` Username: ${user.username ? `@${user.username}` : 'не указан'}\n`);
    parts.push(emoji('question'), ` Full name: ${fullName}\n`);
    parts.push(emoji('question'), ` Баланс: ${adminMoney(user.balance)}\n`);
    parts.push(emoji('question'), ` Покупок: ${user.purchaseCount}\n`);
    parts.push(emoji('question'), ` Регистрация: ${displayDate(user.registeredAt)}\n`);
    parts.push(...(user.bannedAt
      ? [emoji('lock'), ' Статус: ', bold('заблокирован'), ` с ${displayDate(user.bannedAt)}\n`]
      : [emoji('check'), ' Статус: активен\n']));
  }
  return { parts, rows: usersBackRow() };
}

export function adminCreditResultScreen(result) {
  const messages = {
    not_found: `Пользователь ${result.query ?? result.telegramId} не зарегистрирован в базе данных. Баланс не изменён.`,
    balance_limit: 'Операция превышает допустимый максимальный баланс. Баланс не изменён.',
    forbidden: 'Недостаточно прав. Баланс не изменён.',
  };
  const parts = result.status === 'credited'
    ? [emoji('check'), ' ', bold('Баланс пополнен.'), '\n\n',
      emoji('bullet'), ` ID пользователя: ${result.telegramId}\n`,
      emoji('bullet'), ` Зачислено: ${adminMoney(result.amount)}\n`,
      emoji('bullet'), ` Новый баланс: ${adminMoney(result.balance)}\n`,
      'Операция сохранена в журнале.']
    : [emoji('warning'), ' ', messages[result.status] ?? 'Не удалось пополнить баланс.'];
  return { parts, rows: usersBackRow() };
}

export function adminBanResultScreen(result, query) {
  const target = result.telegramId ?? query;
  const label = userLabel(target, result.user);
  if (result.status === 'banned') {
    const rejected = result.rejectedTopUps?.length ?? 0;
    return {
      parts: [emoji('lock'), ' ', bold('Пользователь заблокирован.'), '\n\n',
        emoji('bullet'), ` Пользователь: ${label}\n`,
        emoji('bullet'), ' Доступ к боту закрыт, рассылки ему не приходят.',
        ...(rejected ? ['\n', emoji('bullet'), ` Отклонено чеков на проверке: ${rejected}`] : [])],
      rows: usersBackRow(),
    };
  }
  if (result.status === 'unbanned') {
    return {
      parts: [emoji('check'), ' ', bold('Пользователь разблокирован.'), '\n\n',
        emoji('bullet'), ` Пользователь: ${label}\n`,
        emoji('bullet'), ' Доступ к боту снова открыт.'],
      rows: usersBackRow(),
    };
  }
  const messages = {
    not_found: `Пользователь ${query} не зарегистрирован в базе данных. Изменения не внесены.`,
    already_banned: `Пользователь ${label} уже заблокирован.`,
    not_banned: `Пользователь ${label} не заблокирован.`,
    is_admin: `Нельзя заблокировать администратора ${label}. Сначала удалите его из администраторов.`,
    self: 'Нельзя заблокировать самого себя.',
    forbidden: 'Недостаточно прав. Изменения не внесены.',
  };
  return { parts: [emoji('warning'), ' ', messages[result.status] ?? 'Не удалось выполнить операцию.'], rows: usersBackRow() };
}

export function adminReceiptsScreen({ items, page, pageSize, total, hasPrev, hasNext }, notice = '') {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const parts = [
    emoji('card'), ' ', bold('Непроверенные чеки'), '\n',
    emoji('bullet'), ` Всего: ${total}\n`,
    emoji('bullet'), ` Страница ${page + 1} из ${pageCount}\n\n`,
  ];
  if (notice) parts.push(emoji('check'), ' ', notice, '\n\n');
  if (!items.length) parts.push(emoji('check'), ' Все чеки проверены. Новых заявок нет.');
  else {
    items.forEach((item, index) => {
      parts.push(
        emoji('star'), ' ', bold(`Заявка №${item.id}`), '\n',
        emoji('diamond'), ` Сумма: ${adminMoney(item.amount)}\n`,
        emoji('question'), ` Пользователь: ${userLabel(item.telegramId, item)}\n`,
        emoji('hourglass'), ` Создана: ${displayDate(item.createdAt)}\n`,
      );
      if (index < items.length - 1) parts.push('\n────────────\n\n');
    });
    parts.push('\n', emoji('bullet'), ' Нажмите на заявку, чтобы открыть чек с кнопками «Зачислить» и «Отклонить».');
  }
  const rows = items.map(item => [button(`Открыть чек №${item.id} · ${adminMoney(item.amount)}`,
    `admin_receipt:${item.id}:${page}`, { icon: 'eyes' })]);
  const navigation = [];
  if (hasPrev) navigation.push(button('← Назад', `admin_receipts:${page - 1}`, { icon: 'back' }));
  if (hasNext) navigation.push(button('Далее →', `admin_receipts:${page + 1}`));
  if (navigation.length) rows.push(navigation);
  rows.push([button('Обновить', `admin_receipts_refresh:${page}`, { icon: 'lightning' })], ...backRow());
  return { parts, rows };
}

export function adminBroadcastPreviewScreen(message, recipientCount) {
  return {
    parts: [emoji('warning'), ' ', bold('Проверьте рассылку'), '\n',
      emoji('bullet'), ` Получателей: ${recipientCount}\n\n`, message],
    rows: [[
      button('Отправить всем', 'admin_broadcast_confirm', { icon: 'check' }),
      button('Отмена', 'admin_broadcast_cancel', { icon: 'cancel' }),
    ]],
  };
}

export function adminBroadcastResultScreen({ sent, failed, total }) {
  return {
    parts: [emoji('check'), ' ', bold('Рассылка завершена.'), '\n\n',
      emoji('bullet'), ` Всего получателей: ${total}\n`,
      emoji('bullet'), ` Доставлено: ${sent}\n`,
      emoji('bullet'), ` Не доставлено: ${failed}`],
    rows: backRow(),
  };
}
const userLabel = (id, user) => {
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ');
  return `${id}${user?.username ? ` (@${user.username})` : ''}${name ? `, ${name}` : ''}`;
};
// Подпись к чеку для админов (обычный текст: у подписи нет кастомных эмодзи).
export function topUpAdminCaption(topUp, user, reviewer) {
  const lines = [
    `💳 Заявка на пополнение №${topUp.id}`,
    `Сумма: ${adminMoney(topUp.amount)}`,
    `Пользователь: ${userLabel(topUp.telegramId, user)}`,
    `Создана: ${displayDate(topUp.createdAt)}`,
  ];
  if (user?.bannedAt) lines.push('🔒 Пользователь заблокирован');
  if (topUp.status === 'approved') lines.push('', `✅ Зачислено. Админ: ${userLabel(topUp.reviewedBy, reviewer)}`);
  else if (topUp.status === 'rejected') lines.push('', `❌ Отклонено. Админ: ${userLabel(topUp.reviewedBy, reviewer)}`);
  else lines.push('', 'Проверьте поступление денег и примите решение.');
  return lines.join('\n').slice(0, 1024);
}
export function topUpAdminKeyboard(topUpId) {
  return { inline_keyboard: [[
    { text: 'Зачислить', callback_data: `topup_approve:${topUpId}`, style: 'success' },
    { text: 'Отклонить', callback_data: `topup_reject:${topUpId}`, style: 'danger' },
  ]] };
}