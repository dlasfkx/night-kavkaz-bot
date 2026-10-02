import { DatabaseSync } from 'node:sqlite';
import { mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { migrateSchema, importLegacyUsers, seedInitialCatalog } from './database/migrations.js';
function telegramId(id) {
  const value = String(id);
  if (!/^[1-9]\d*$/.test(value)) throw new TypeError('Некорректный Telegram ID.');
  return value;
}
export async function createStore(file, { legacyPath, bootstrapAdminIds = [] } = {}) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  try {
    if (process.platform !== 'win32') await chmod(file, 0o600);
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');
    migrateSchema(db);
    await importLegacyUsers(db, legacyPath);
    seedInitialCatalog(db);
    if (!Array.isArray(bootstrapAdminIds)) throw new TypeError('Некорректный список администраторов.');
    const systemAdminIds = new Set(bootstrapAdminIds.map(telegramId));
    const seedAdmin = db.prepare(`INSERT INTO admins (telegram_id, added_by) VALUES (?, NULL)
      ON CONFLICT(telegram_id) DO UPDATE SET added_by = NULL`);
    for (const id of bootstrapAdminIds) seedAdmin.run(telegramId(id));
    const getUser = db.prepare(`SELECT telegram_id AS telegramId, accepted_at AS acceptedAt,
      rules_version AS rulesVersion, balance,
      username, first_name AS firstName, last_name AS lastName, registered_at AS registeredAt,
      (SELECT count(*) FROM purchases WHERE purchases.telegram_id = users.telegram_id AND purchases.status = 'completed') AS purchaseCount,
      users.banned_at AS bannedAt
      FROM users WHERE telegram_id = ?`);
    const accept = db.prepare(`INSERT INTO users (telegram_id, accepted_at, rules_version, registered_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT (telegram_id) DO UPDATE SET
        accepted_at = CASE WHEN users.accepted_at IS NULL OR users.rules_version <> excluded.rules_version
          THEN excluded.accepted_at ELSE users.accepted_at END,
        rules_version = excluded.rules_version,
        registered_at = COALESCE(users.registered_at, excluded.registered_at)`);
    const listProducts = db.prepare(`SELECT id, slug, title, description, price,
      original_price AS originalPrice, currency
      FROM products WHERE is_active = 1 ORDER BY sort_order, id`);
    const getProduct = db.prepare(`SELECT id, slug, title, description, price,
      original_price AS originalPrice, currency
      FROM products WHERE id = ? AND is_active = 1`);
    const listPurchases = db.prepare(`SELECT id, product_title AS productTitle, quantity,
      total, currency, purchased_at AS purchasedAt, invite_link AS inviteLink
      FROM purchases WHERE telegram_id = ? AND status = 'completed' ORDER BY purchased_at DESC, id DESC LIMIT ? OFFSET ?`);
    const findPurchaseByCallback = db.prepare(`SELECT id, total, currency
      FROM purchases WHERE purchase_callback_id = ?`);
    const findUserProductPurchase = db.prepare(`SELECT id, purchased_at AS purchasedAt
      FROM purchases WHERE telegram_id = ? AND product_id = ? ORDER BY id LIMIT 1`);
    const listUserProductIdsQuery = db.prepare(`SELECT DISTINCT product_id AS productId FROM purchases
      WHERE telegram_id = ? AND product_id IS NOT NULL`);
    const productForPurchase = db.prepare(`SELECT id, slug, title, price, currency
      FROM products WHERE id = ? AND is_active = 1`);
    const balanceForPurchase = db.prepare('SELECT balance FROM users WHERE telegram_id = ?');
    const debitBalance = db.prepare(`UPDATE users SET balance = balance - ?
      WHERE telegram_id = ? AND balance >= ?`);
    const insertPurchase = db.prepare(`INSERT INTO purchases
      (telegram_id, product_id, product_title, quantity, total, currency, purchase_callback_id, status)
      VALUES (?, ?, ?, 1, ?, ?, ?, 'pending')`);
    // Покупка сначала pending: деньги списаны, ссылка ещё не создана.
    const pendingPurchase = db.prepare(`SELECT id, telegram_id AS telegramId, total
      FROM purchases WHERE id = ? AND status = 'pending'`);
    const allPendingPurchases = db.prepare("SELECT id FROM purchases WHERE status = 'pending' ORDER BY id");
    const completePurchaseQuery = db.prepare(`UPDATE purchases SET status = 'completed', invite_link = ?
      WHERE id = ? AND status = 'pending'`);
    const deletePurchase = db.prepare("DELETE FROM purchases WHERE id = ? AND status = 'pending'");
    const refundBalance = db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?');
    const pendingCardTopUpCount = db.prepare(`SELECT count(*) AS count FROM top_ups
      WHERE telegram_id = ? AND method = 'card' AND status = 'pending'`);
    const insertCardTopUp = db.prepare(`INSERT INTO top_ups
      (telegram_id, method, amount, status, receipt_file_id, receipt_kind) VALUES (?, 'card', ?, 'pending', ?, ?)`);
    const getTopUpQuery = db.prepare(`SELECT id, telegram_id AS telegramId, method, amount, stars, status,
      receipt_file_id AS receiptFileId, receipt_kind AS receiptKind, reviewed_by AS reviewedBy,
      reviewed_at AS reviewedAt, created_at AS createdAt FROM top_ups WHERE id = ?`);
    const reviewTopUpQuery = db.prepare(`UPDATE top_ups SET status = ?, reviewed_by = ?,
      reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'pending'`);
    const insertTopUpMessage = db.prepare(`INSERT INTO top_up_admin_messages (top_up_id, chat_id, message_id)
      VALUES (?, ?, ?) ON CONFLICT DO NOTHING`);
    const listTopUpMessagesQuery = db.prepare(`SELECT chat_id AS chatId, message_id AS messageId
      FROM top_up_admin_messages WHERE top_up_id = ?`);
    const findStarsCharge = db.prepare('SELECT id FROM top_ups WHERE telegram_charge_id = ?');
    const insertStarsTopUp = db.prepare(`INSERT INTO top_ups
      (telegram_id, method, amount, stars, status, telegram_charge_id) VALUES (?, 'stars', ?, ?, 'approved', ?)`);
    const isAdminQuery = db.prepare('SELECT 1 AS yes FROM admins WHERE telegram_id = ?');
    const isSystemAdminQuery = db.prepare('SELECT 1 AS yes FROM admins WHERE telegram_id = ? AND added_by IS NULL');
    const findAdminTargetById = db.prepare('SELECT telegram_id AS telegramId, added_by AS addedBy FROM admins WHERE telegram_id = ?');
    const findAdminTargetByUsername = db.prepare(`SELECT admins.telegram_id AS telegramId, admins.added_by AS addedBy
      FROM admins LEFT JOIN users ON users.telegram_id = admins.telegram_id
      WHERE users.username = ? COLLATE NOCASE LIMIT 1`);
    const deleteManagedAdmin = db.prepare('DELETE FROM admins WHERE telegram_id = ? AND added_by IS NOT NULL');
    const getMaintenanceModeQuery = db.prepare("SELECT value FROM app_meta WHERE key = 'maintenance_mode'");
    const setMaintenanceModeQuery = db.prepare(`INSERT INTO app_meta (key, value) VALUES ('maintenance_mode', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    const listAdminsQuery = db.prepare(`SELECT admins.telegram_id AS telegramId, admins.added_at AS addedAt,
      admins.added_by AS addedBy, users.username, users.first_name AS firstName, users.last_name AS lastName,
      users.registered_at AS registeredAt, users.balance,
      (SELECT count(*) FROM purchases WHERE purchases.telegram_id = admins.telegram_id AND purchases.status = 'completed') AS purchaseCount
      FROM admins LEFT JOIN users ON users.telegram_id = admins.telegram_id
      ORDER BY admins.added_at, admins.telegram_id`);
    const adminCountQuery = db.prepare('SELECT count(*) AS count FROM admins');
    const pageAdminsQuery = db.prepare(`SELECT admins.telegram_id AS telegramId, admins.added_at AS addedAt,
      admins.added_by AS addedBy, users.username, users.first_name AS firstName, users.last_name AS lastName,
      users.registered_at AS registeredAt, users.balance,
      (SELECT count(*) FROM purchases WHERE purchases.telegram_id = admins.telegram_id AND purchases.status = 'completed') AS purchaseCount
      FROM admins LEFT JOIN users ON users.telegram_id = admins.telegram_id
      ORDER BY admins.added_at, admins.telegram_id LIMIT ? OFFSET ?`);
    const insertAdmin = db.prepare('INSERT INTO admins (telegram_id, added_by) VALUES (?, ?) ON CONFLICT DO NOTHING');
    const userCountQuery = db.prepare('SELECT count(*) AS count FROM users');
    const userLookupQuery = db.prepare(`SELECT telegram_id AS telegramId, accepted_at AS acceptedAt,
      rules_version AS rulesVersion, balance,
      username, first_name AS firstName, last_name AS lastName, registered_at AS registeredAt,
      (SELECT count(*) FROM purchases WHERE purchases.telegram_id = users.telegram_id AND purchases.status = 'completed') AS purchaseCount,
      users.banned_at AS bannedAt
      FROM users WHERE telegram_id = ?`);
    const userByUsernameQuery = db.prepare(`SELECT telegram_id AS telegramId, accepted_at AS acceptedAt,
      rules_version AS rulesVersion, balance, username, first_name AS firstName,
      last_name AS lastName, registered_at AS registeredAt,
      (SELECT count(*) FROM purchases WHERE purchases.telegram_id = users.telegram_id AND purchases.status = 'completed') AS purchaseCount,
      users.banned_at AS bannedAt
      FROM users WHERE username = ? COLLATE NOCASE LIMIT 1`);
    const allUserIdsQuery = db.prepare('SELECT telegram_id AS telegramId FROM users ORDER BY telegram_id');
    const ordinaryUserIdsQuery = db.prepare(`SELECT users.telegram_id AS telegramId FROM users
      WHERE NOT EXISTS (SELECT 1 FROM admins WHERE admins.telegram_id = users.telegram_id)
        AND users.banned_at IS NULL
      ORDER BY users.telegram_id`);
    const pageUsersQuery = db.prepare(`SELECT telegram_id AS telegramId, username,
      first_name AS firstName, last_name AS lastName, balance,
      registered_at AS registeredAt,
      (SELECT count(*) FROM purchases WHERE purchases.telegram_id = users.telegram_id AND purchases.status = 'completed') AS purchaseCount,
      users.banned_at AS bannedAt
      FROM users ORDER BY registered_at, telegram_id LIMIT ? OFFSET ?`);
    // Покупатель: есть хотя бы одна завершённая покупка или положительный баланс.
    const BUYER_CONDITION = `(users.balance > 0 OR EXISTS (
        SELECT 1 FROM purchases WHERE purchases.telegram_id = users.telegram_id AND purchases.status = 'completed'
      ))`;
    const buyersCountQuery = db.prepare(`SELECT count(*) AS count FROM users WHERE ${BUYER_CONDITION}`);
    const pageBuyersQuery = db.prepare(`SELECT telegram_id AS telegramId, username,
      first_name AS firstName, last_name AS lastName, balance,
      registered_at AS registeredAt,
      (SELECT count(*) FROM purchases WHERE purchases.telegram_id = users.telegram_id AND purchases.status = 'completed') AS purchaseCount,
      users.banned_at AS bannedAt
      FROM users WHERE ${BUYER_CONDITION}
      ORDER BY registered_at, telegram_id LIMIT ? OFFSET ?`);
    const updateProfileQuery = db.prepare(`INSERT INTO users
      (telegram_id, username, first_name, last_name, registered_at)
      VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT (telegram_id) DO UPDATE SET
        username = excluded.username, first_name = excluded.first_name, last_name = excluded.last_name`);
    const updateBalanceQuery = db.prepare(`UPDATE users SET balance = balance + ?
      WHERE telegram_id = ? AND balance <= ?`);
    const balanceAfterQuery = db.prepare('SELECT balance FROM users WHERE telegram_id = ?');
    const insertCreditAudit = db.prepare(`INSERT INTO admin_balance_transactions
      (telegram_id, admin_id, amount, balance_after) VALUES (?, ?, ?, ?)`);
    const isBannedQuery = db.prepare('SELECT 1 AS yes FROM users WHERE telegram_id = ? AND banned_at IS NOT NULL');
    const banUserQuery = db.prepare(`UPDATE users SET banned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), banned_by = ?
      WHERE telegram_id = ? AND banned_at IS NULL`);
    const unbanUserQuery = db.prepare(`UPDATE users SET banned_at = NULL, banned_by = NULL
      WHERE telegram_id = ? AND banned_at IS NOT NULL`);
    const pendingCardTopUpIdsOfUser = db.prepare(`SELECT id FROM top_ups
      WHERE telegram_id = ? AND method = 'card' AND status = 'pending' ORDER BY id`);
    const latestPendingCardTopUp = db.prepare(`SELECT id FROM top_ups
      WHERE telegram_id = ? AND method = 'card' AND status = 'pending' ORDER BY id LIMIT 1`);
    const pendingReceiptsCountQuery = db.prepare(`SELECT count(*) AS count FROM top_ups
      WHERE method = 'card' AND status = 'pending'`);
    const pagePendingReceiptsQuery = db.prepare(`SELECT top_ups.id, top_ups.telegram_id AS telegramId,
      top_ups.amount, top_ups.created_at AS createdAt, top_ups.receipt_kind AS receiptKind,
      users.username, users.first_name AS firstName, users.last_name AS lastName
      FROM top_ups LEFT JOIN users ON users.telegram_id = top_ups.telegram_id
      WHERE top_ups.method = 'card' AND top_ups.status = 'pending'
      ORDER BY top_ups.created_at, top_ups.id LIMIT ? OFFSET ?`);
    const MAX_BALANCE = 9007199254740991;
    const purchaseIdOf = value => {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Некорректный номер покупки.');
      return value;
    };
    // Откат незавершённой покупки: возвращаем деньги и удаляем запись.
    function revertPurchase(purchaseId) {
      const idValue = purchaseIdOf(purchaseId);
      db.exec('BEGIN IMMEDIATE');
      try {
        const pending = pendingPurchase.get(idValue);
        if (!pending) { db.exec('COMMIT'); return { status: 'not_pending' }; }
        refundBalance.run(pending.total, pending.telegramId);
        deletePurchase.run(idValue);
        const balance = balanceForPurchase.get(pending.telegramId)?.balance ?? 0;
        db.exec('COMMIT');
        return { status: 'reverted', balance, refunded: pending.total };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    // После падения процесса между списанием и выдачей ссылки деньги возвращаются при старте.
    for (const { id: pendingId } of allPendingPurchases.all()) revertPurchase(pendingId);
    function pageUsers(buyersOnly, page = 0, pageSize = 5) {
      if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(pageSize) ||
          pageSize < 1 || pageSize > 10 || !Number.isSafeInteger(page * pageSize)) {
        throw new TypeError('Некорректная страница пользователей.');
      }
      const total = (buyersOnly ? buyersCountQuery : userCountQuery).get().count;
      const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);
      const safePage = Math.min(page, lastPage);
      const rows = (buyersOnly ? pageBuyersQuery : pageUsersQuery).all(pageSize + 1, safePage * pageSize);
      return { items: rows.slice(0, pageSize), hasPrev: safePage > 0,
        hasNext: rows.length > pageSize, page: safePage, pageSize, total };
    }
    let closed = false;
    return {
      // Кешируется SQL, не результаты: каждый вызов читает текущую базу.
      get(id) { return getUser.get(telegramId(id)); },
      isAdmin(id) { return Boolean(isAdminQuery.get(telegramId(id))); },
      isSystemAdmin(id) {
        const adminId = telegramId(id);
        return systemAdminIds.has(adminId) && Boolean(isSystemAdminQuery.get(adminId));
      },
      isMaintenanceMode() { return getMaintenanceModeQuery.get()?.value === '1'; },
      setMaintenanceMode(enabled) {
        if (typeof enabled !== 'boolean') throw new TypeError('Режим техработ должен быть включён или выключен.');
        setMaintenanceModeQuery.run(enabled ? '1' : '0');
        return enabled;
      },
      listAdmins() { return listAdminsQuery.all(); },
      listAdminPage(page = 0, pageSize = 5) {
        if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 10) {
          throw new TypeError('Некорректная страница администраторов.');
        }
        const total = adminCountQuery.get().count;
        const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);
        const safePage = Math.min(page, lastPage);
        const rows = pageAdminsQuery.all(pageSize + 1, safePage * pageSize);
        return { items: rows.slice(0, pageSize), hasPrev: safePage > 0, hasNext: rows.length > pageSize, page: safePage, pageSize, total };
      },
      addAdmin(userQuery, addedBy) {
        const query = String(userQuery ?? '').trim();
        const targetId = /^[1-9]\d{0,19}$/.test(query) ? query : null;
        const username = query.replace(/^@/, '');
        const validUsername = !targetId && /^[A-Za-z0-9_]{1,32}$/.test(username);
        if (!targetId && !validUsername) throw new TypeError('Некорректный Telegram ID или username.');
        const actor = telegramId(addedBy);
        db.exec('BEGIN IMMEDIATE');
        try {
          if (!systemAdminIds.has(actor) || !isSystemAdminQuery.get(actor)) {
            db.exec('COMMIT');
            return { status: 'forbidden' };
          }
          const registered = targetId ? userLookupQuery.get(targetId) : userByUsernameQuery.get(username);
          if (!registered) {
            db.exec('COMMIT');
            return { status: 'not_found', query };
          }
          const target = registered.telegramId;
          const result = insertAdmin.run(target, actor);
          db.exec('COMMIT');
          return { status: result.changes ? 'added' : 'already_admin', telegramId: target, user: registered };
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
      removeAdmin(userQuery, removedBy) {
        const query = String(userQuery ?? '').trim();
        const targetId = /^[1-9]\d{0,19}$/.test(query) ? query : null;
        const username = query.replace(/^@/, '');
        const validUsername = !targetId && /^[A-Za-z0-9_]{1,32}$/.test(username);
        if (!targetId && !validUsername) throw new TypeError('Некорректный Telegram ID или username.');
        const actor = telegramId(removedBy);
        db.exec('BEGIN IMMEDIATE');
        try {
          if (!systemAdminIds.has(actor) || !isSystemAdminQuery.get(actor)) {
            db.exec('COMMIT');
            return { status: 'forbidden' };
          }
          const target = targetId ? findAdminTargetById.get(targetId) : findAdminTargetByUsername.get(username);
          if (!target) { db.exec('COMMIT'); return { status: 'not_admin', query }; }
          if (target.addedBy == null) { db.exec('COMMIT'); return { status: 'system_admin', telegramId: target.telegramId }; }
          const result = deleteManagedAdmin.run(target.telegramId);
          db.exec('COMMIT');
          return { status: result.changes ? 'removed' : 'not_admin', telegramId: target.telegramId };
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
      registeredUserCount() { return userCountQuery.get().count; },
      findRegisteredUser(query) {
        const value = String(query ?? '').trim();
        if (/^[1-9]\d{0,19}$/.test(value)) return userLookupQuery.get(value);
        const username = value.replace(/^@/, '');
        if (!/^[A-Za-z0-9_]{1,32}$/.test(username)) return undefined;
        return userByUsernameQuery.get(username);
      },
      listRegisteredUserIds() { return allUserIdsQuery.all().map(row => row.telegramId); },
      listOrdinaryUserIds() { return ordinaryUserIdsQuery.all().map(row => row.telegramId); },
      listUsers(page = 0, pageSize = 5) {
        return pageUsers(false, page, pageSize);
      },
      listBuyers(page = 0, pageSize = 5) {
        return pageUsers(true, page, pageSize);
      },
      updateUserProfile(user) {
        const id = telegramId(user?.id);
        const clean = value => typeof value === 'string' ? value.trim().slice(0, 256) || null : null;
        updateProfileQuery.run(id, clean(user.username), clean(user.first_name), clean(user.last_name));
      },
      creditUser(adminId, userQuery, amount) {
        const actor = telegramId(adminId);
        const query = String(userQuery ?? '').trim();
        const idQuery = /^[1-9]\d{0,19}$/.test(query) ? query : null;
        const username = query.replace(/^@/, '');
        const validUsername = !idQuery && /^[A-Za-z0-9_]{1,32}$/.test(username);
        if (!idQuery && !validUsername) throw new TypeError('Некорректный Telegram ID или username.');
        if (!Number.isSafeInteger(amount) || amount < 1 || amount > 9007199254740991) {
          throw new TypeError('Сумма пополнения должна быть положительным целым числом рублей.');
        }
        db.exec('BEGIN IMMEDIATE');
        try {
          if (!isAdminQuery.get(actor)) { db.exec('COMMIT'); return { status: 'forbidden' }; }
          const registered = idQuery ? userLookupQuery.get(idQuery) : userByUsernameQuery.get(username);
          if (!registered) { db.exec('COMMIT'); return { status: 'not_found', query }; }
          const target = registered.telegramId;
          const result = updateBalanceQuery.run(amount, target, 9007199254740991 - amount);
          if (result.changes !== 1) { db.exec('COMMIT'); return { status: 'balance_limit' }; }
          const balance = balanceAfterQuery.get(target).balance;
          insertCreditAudit.run(target, actor, amount, balance);
          db.exec('COMMIT');
          return { status: 'credited', telegramId: target, amount, balance };
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      isBanned(id) { return Boolean(isBannedQuery.get(telegramId(id))); },
      // Блокировка: пользователь теряет доступ к боту, его чеки на проверке отклоняются.
      banUser(adminId, userQuery) {
        const actor = telegramId(adminId);
        const query = String(userQuery ?? '').trim();
        const idQuery = /^[1-9]\d{0,19}$/.test(query) ? query : null;
        const username = query.replace(/^@/, '');
        if (!idQuery && !/^[A-Za-z0-9_]{1,32}$/.test(username)) throw new TypeError('Некорректный Telegram ID или username.');
        db.exec('BEGIN IMMEDIATE');
        try {
          if (!isAdminQuery.get(actor)) { db.exec('COMMIT'); return { status: 'forbidden' }; }
          const registered = idQuery ? userLookupQuery.get(idQuery) : userByUsernameQuery.get(username);
          if (!registered) { db.exec('COMMIT'); return { status: 'not_found', query }; }
          const target = registered.telegramId;
          if (target === actor) { db.exec('COMMIT'); return { status: 'self', telegramId: target, user: registered }; }
          if (isAdminQuery.get(target)) { db.exec('COMMIT'); return { status: 'is_admin', telegramId: target, user: registered }; }
          if (registered.bannedAt) { db.exec('COMMIT'); return { status: 'already_banned', telegramId: target, user: registered }; }
          banUserQuery.run(actor, target);
          const rejectedIds = pendingCardTopUpIdsOfUser.all(target).map(row => row.id);
          for (const topUpId of rejectedIds) reviewTopUpQuery.run('rejected', actor, topUpId);
          db.exec('COMMIT');
          return { status: 'banned', telegramId: target, user: registered,
            rejectedTopUps: rejectedIds.map(topUpId => getTopUpQuery.get(topUpId)) };
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      unbanUser(adminId, userQuery) {
        const actor = telegramId(adminId);
        const query = String(userQuery ?? '').trim();
        const idQuery = /^[1-9]\d{0,19}$/.test(query) ? query : null;
        const username = query.replace(/^@/, '');
        if (!idQuery && !/^[A-Za-z0-9_]{1,32}$/.test(username)) throw new TypeError('Некорректный Telegram ID или username.');
        db.exec('BEGIN IMMEDIATE');
        try {
          if (!isAdminQuery.get(actor)) { db.exec('COMMIT'); return { status: 'forbidden' }; }
          const registered = idQuery ? userLookupQuery.get(idQuery) : userByUsernameQuery.get(username);
          if (!registered) { db.exec('COMMIT'); return { status: 'not_found', query }; }
          const result = unbanUserQuery.run(registered.telegramId);
          db.exec('COMMIT');
          return { status: result.changes ? 'unbanned' : 'not_banned', telegramId: registered.telegramId, user: registered };
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      pendingCardTopUp(id) {
        const row = latestPendingCardTopUp.get(telegramId(id));
        return row ? getTopUpQuery.get(row.id) : undefined;
      },
      pendingReceiptCount() { return pendingReceiptsCountQuery.get().count; },
      listPendingReceipts(page = 0, pageSize = 5) {
        if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(pageSize) ||
            pageSize < 1 || pageSize > 10 || !Number.isSafeInteger(page * pageSize)) {
          throw new TypeError('Некорректная страница чеков.');
        }
        const total = pendingReceiptsCountQuery.get().count;
        const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);
        const safePage = Math.min(page, lastPage);
        const rows = pagePendingReceiptsQuery.all(pageSize + 1, safePage * pageSize);
        return { items: rows.slice(0, pageSize), hasPrev: safePage > 0,
          hasNext: rows.length > pageSize, page: safePage, pageSize, total };
      },
      accept(id, rulesVersion = 1) {
        if (!Number.isSafeInteger(rulesVersion) || rulesVersion < 1) throw new TypeError('Некорректная версия правил.');
        accept.run(telegramId(id), new Date().toISOString(), rulesVersion);
        return getUser.get(telegramId(id));
      },
      listProducts() { return { items: listProducts.all(), hasNext: false }; },
      listPurchasedProductIds(id) { return listUserProductIdsQuery.all(telegramId(id)).map(row => row.productId); },
      hasPurchasedProduct(id, productId) {
        if (!Number.isSafeInteger(productId) || productId < 1) throw new TypeError('Некорректный ID товара.');
        return Boolean(findUserProductPurchase.get(telegramId(id), productId));
      },
      getProduct(id) {
        if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('Некорректный ID товара.');
        return getProduct.get(id);
      },
      purchaseProduct(id, productId, callbackId, expectedPrice) {
        const user = telegramId(id);
        if (!Number.isSafeInteger(productId) || productId < 1) throw new TypeError('Некорректный ID товара.');
        if (typeof callbackId !== 'string' || callbackId.length < 1 || callbackId.length > 256) {
          throw new TypeError('Некорректный ID подтверждения покупки.');
        }
        if (!Number.isSafeInteger(expectedPrice) || expectedPrice < 0) {
          throw new TypeError('Некорректная подтверждённая цена.');
        }
        db.exec('BEGIN IMMEDIATE');
        try {
          const previous = findPurchaseByCallback.get(callbackId);
          if (previous) {
            const balance = balanceForPurchase.get(user)?.balance ?? 0;
            db.exec('COMMIT');
            return { status: 'already_processed', balance: balance, purchaseId: previous.id };
          }
          const product = productForPurchase.get(productId);
          if (!product) {
            db.exec('COMMIT');
            return { status: 'unavailable' };
          }
          const previousProductPurchase = findUserProductPurchase.get(user, product.id);
          if (previousProductPurchase) {
            db.exec('COMMIT');
            return { status: 'already_owned', productTitle: product.title, purchaseId: previousProductPurchase.id };
          }
          if (product.price !== expectedPrice) {
            const current = balanceForPurchase.get(user);
            db.exec('COMMIT');
            return { status: 'price_changed', balance: current?.balance ?? 0,
              price: product.price, productId: product.id };
          }
          const current = balanceForPurchase.get(user);
          if (!current) {
            db.exec('COMMIT');
            return { status: 'user_not_found' };
          }
          if (current.balance < product.price) {
            db.exec('COMMIT');
            return { status: 'insufficient_funds', balance: current.balance,
              price: product.price, productTitle: product.title };
          }
          const debit = debitBalance.run(product.price, user, product.price);
          if (debit.changes !== 1) {
            const freshBalance = balanceForPurchase.get(user)?.balance ?? 0;
            db.exec('COMMIT');
            return { status: 'insufficient_funds', balance: freshBalance,
              price: product.price, productTitle: product.title };
          }
          const inserted = insertPurchase.run(user, product.id, product.title, product.price, product.currency, callbackId);
          const balance = balanceForPurchase.get(user).balance;
          db.exec('COMMIT');
          return { status: 'purchased', balance, price: product.price, currency: product.currency,
            productTitle: product.title, productSlug: product.slug, purchaseId: Number(inserted.lastInsertRowid) };
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
      listPurchases(id, page = 0, pageSize = 5) {
        if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(pageSize) ||
            pageSize < 1 || pageSize > 5 || !Number.isSafeInteger(page * pageSize)) {
          throw new TypeError('Некорректная страница покупок.');
        }
        const rows = listPurchases.all(telegramId(id), pageSize + 1, page * pageSize);
        return { items: rows.slice(0, pageSize), hasNext: rows.length > pageSize };
      },
      completePurchase(purchaseId, inviteLink) {
        if (typeof inviteLink !== 'string' || !/^https:\/\/t\.me\/\S{1,200}$/.test(inviteLink)) {
          throw new TypeError('Некорректная ссылка-приглашение.');
        }
        return completePurchaseQuery.run(inviteLink, purchaseIdOf(purchaseId)).changes === 1;
      },
      revertPurchase,
      createCardTopUp(id, amount, receiptFileId, receiptKind, maxPending = 1) {
        const user = telegramId(id);
        if (!Number.isSafeInteger(amount) || amount < 1) throw new TypeError('Некорректная сумма пополнения.');
        if (typeof receiptFileId !== 'string' || !receiptFileId || receiptFileId.length > 512) {
          throw new TypeError('Некорректный файл чека.');
        }
        if (!['photo', 'document'].includes(receiptKind)) throw new TypeError('Некорректный тип чека.');
        db.exec('BEGIN IMMEDIATE');
        try {
          if (!balanceForPurchase.get(user)) { db.exec('COMMIT'); return { status: 'user_not_found' }; }
          if (pendingCardTopUpCount.get(user).count >= maxPending) { db.exec('COMMIT'); return { status: 'too_many' }; }
          const inserted = insertCardTopUp.run(user, amount, receiptFileId, receiptKind);
          db.exec('COMMIT');
          return { status: 'created', topUp: getTopUpQuery.get(Number(inserted.lastInsertRowid)) };
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      getTopUp(topUpId) {
        if (!Number.isSafeInteger(topUpId) || topUpId < 1) throw new TypeError('Некорректный номер заявки.');
        return getTopUpQuery.get(topUpId);
      },
      addTopUpAdminMessage(topUpId, chatId, messageId) {
        insertTopUpMessage.run(topUpId, String(chatId), messageId);
      },
      listTopUpAdminMessages(topUpId) { return listTopUpMessagesQuery.all(topUpId); },
      reviewCardTopUp(topUpId, adminId, decision) {
        const actor = telegramId(adminId);
        if (!Number.isSafeInteger(topUpId) || topUpId < 1) throw new TypeError('Некорректный номер заявки.');
        if (!['approved', 'rejected'].includes(decision)) throw new TypeError('Некорректное решение.');
        db.exec('BEGIN IMMEDIATE');
        try {
          if (!isAdminQuery.get(actor)) { db.exec('COMMIT'); return { status: 'forbidden' }; }
          const topUp = getTopUpQuery.get(topUpId);
          if (!topUp || topUp.method !== 'card') { db.exec('COMMIT'); return { status: 'not_found' }; }
          if (topUp.status !== 'pending') { db.exec('COMMIT'); return { status: 'already_reviewed', topUp }; }
          if (decision === 'approved') {
            const credited = updateBalanceQuery.run(topUp.amount, topUp.telegramId, MAX_BALANCE - topUp.amount);
            if (credited.changes !== 1) { db.exec('COMMIT'); return { status: 'balance_limit', topUp }; }
          }
          reviewTopUpQuery.run(decision, actor, topUpId);
          const balance = balanceAfterQuery.get(topUp.telegramId)?.balance ?? 0;
          db.exec('COMMIT');
          return { status: decision, topUp: getTopUpQuery.get(topUpId), balance };
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      creditStarsTopUp(id, amount, stars, chargeId) {
        const user = telegramId(id);
        if (!Number.isSafeInteger(amount) || amount < 1) throw new TypeError('Некорректная сумма пополнения.');
        if (!Number.isSafeInteger(stars) || stars < 1) throw new TypeError('Некорректное количество звёзд.');
        if (typeof chargeId !== 'string' || !chargeId || chargeId.length > 256) throw new TypeError('Некорректный ID платежа.');
        db.exec('BEGIN IMMEDIATE');
        try {
          if (findStarsCharge.get(chargeId)) {
            const balance = balanceAfterQuery.get(user)?.balance ?? 0;
            db.exec('COMMIT');
            return { status: 'already_processed', balance };
          }
          if (!balanceForPurchase.get(user)) { db.exec('COMMIT'); return { status: 'user_not_found' }; }
          const credited = updateBalanceQuery.run(amount, user, MAX_BALANCE - amount);
          if (credited.changes !== 1) { db.exec('COMMIT'); return { status: 'balance_limit' }; }
          const inserted = insertStarsTopUp.run(user, amount, stars, chargeId);
          const balance = balanceAfterQuery.get(user).balance;
          db.exec('COMMIT');
          return { status: 'credited', balance, amount, stars, topUpId: Number(inserted.lastInsertRowid) };
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      close() { if (!closed) { db.close(); closed = true; } },
    };
  } catch (error) { db.close(); throw error; }
}