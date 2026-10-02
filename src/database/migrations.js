import { readFile } from 'node:fs/promises';
const migrations = [{ version: 1, sql: `
  CREATE TABLE users (
    telegram_id TEXT PRIMARY KEY,
    accepted_at TEXT,
    rules_version INTEGER NOT NULL DEFAULT 0 CHECK (rules_version >= 0)
  );
  CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
    price_minor INTEGER NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
    currency TEXT NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX products_active_order ON products(is_active, sort_order, id);
  CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
` }, { version: 2, sql: `
  ALTER TABLE users ADD COLUMN balance_minor INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(balance_minor) = 'integer' AND balance_minor BETWEEN 0 AND 9007199254740991);
  CREATE TABLE purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE RESTRICT,
    product_title TEXT NOT NULL CHECK (length(trim(product_title)) BETWEEN 1 AND 200),
    quantity INTEGER NOT NULL DEFAULT 1
      CHECK (typeof(quantity) = 'integer' AND quantity BETWEEN 1 AND 1000000),
    total_minor INTEGER NOT NULL
      CHECK (typeof(total_minor) = 'integer' AND total_minor BETWEEN 0 AND 9007199254740991),
    currency TEXT NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    purchased_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      CHECK (julianday(purchased_at) IS NOT NULL)
  );
  CREATE INDEX purchases_user_date ON purchases(telegram_id, purchased_at DESC, id DESC);
` }, { version: 3, sql: `
  ALTER TABLE products ADD COLUMN original_price_minor INTEGER
    CHECK (original_price_minor IS NULL OR (typeof(original_price_minor) = 'integer' AND original_price_minor >= 0));
  ALTER TABLE products ADD COLUMN slug TEXT;
  CREATE UNIQUE INDEX products_slug ON products(slug) WHERE slug IS NOT NULL;
` }, { version: 4, sql: `
  ALTER TABLE purchases ADD COLUMN purchase_callback_id TEXT;
  CREATE UNIQUE INDEX purchases_callback_id ON purchases(purchase_callback_id)
    WHERE purchase_callback_id IS NOT NULL;
` }, { version: 5, sql: `
  CREATE TABLE admins (
    telegram_id TEXT PRIMARY KEY CHECK (telegram_id GLOB '[1-9]*' AND telegram_id NOT GLOB '*[^0-9]*'),
    added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    added_by TEXT
  );
  CREATE TABLE admin_balance_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE RESTRICT,
    admin_id TEXT NOT NULL REFERENCES admins(telegram_id) ON DELETE RESTRICT,
    amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0),
    balance_after_minor INTEGER NOT NULL CHECK (typeof(balance_after_minor) = 'integer' AND balance_after_minor >= 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX admin_balance_user_date ON admin_balance_transactions(telegram_id, created_at DESC);
` }, { version: 6, sql: `
  ALTER TABLE users ADD COLUMN username TEXT;
  ALTER TABLE users ADD COLUMN first_name TEXT;
  ALTER TABLE users ADD COLUMN last_name TEXT;
  ALTER TABLE users ADD COLUMN registered_at TEXT;
  UPDATE users SET registered_at = COALESCE(accepted_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  CREATE INDEX users_registered_order ON users(registered_at, telegram_id);
` }, { version: 7, sql: `
  ALTER TABLE purchases ADD COLUMN product_id INTEGER REFERENCES products(id) ON DELETE RESTRICT;
  UPDATE purchases SET product_id = (
    SELECT products.id FROM products WHERE lower(trim(products.title)) = lower(trim(purchases.product_title)) ORDER BY products.id LIMIT 1
  ) WHERE product_id IS NULL;
  CREATE INDEX purchases_user_product ON purchases(telegram_id, product_id);
` }, { version: 8, sql: `
  -- Переход с копеек на целые рубли. Баланс округляется вниз, цены и суммы к ближайшему рублю.
  UPDATE users SET balance_minor = balance_minor / 100;
  ALTER TABLE users RENAME COLUMN balance_minor TO balance;
  UPDATE products SET price_minor = (price_minor + 50) / 100,
    original_price_minor = CASE WHEN original_price_minor IS NULL THEN NULL ELSE (original_price_minor + 50) / 100 END;
  ALTER TABLE products RENAME COLUMN price_minor TO price;
  ALTER TABLE products RENAME COLUMN original_price_minor TO original_price;
  UPDATE purchases SET total_minor = (total_minor + 50) / 100;
  ALTER TABLE purchases RENAME COLUMN total_minor TO total;
  UPDATE admin_balance_transactions SET amount_minor = max(1, (amount_minor + 50) / 100),
    balance_after_minor = balance_after_minor / 100;
  ALTER TABLE admin_balance_transactions RENAME COLUMN amount_minor TO amount;
  ALTER TABLE admin_balance_transactions RENAME COLUMN balance_after_minor TO balance_after;
` }, { version: 9, sql: `
  ALTER TABLE purchases ADD COLUMN invite_link TEXT;
  ALTER TABLE purchases ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'
    CHECK (status IN ('pending', 'completed'));
  CREATE TABLE top_ups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE RESTRICT,
    method TEXT NOT NULL CHECK (method IN ('card', 'stars')),
    amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount > 0),
    stars INTEGER CHECK (stars IS NULL OR (typeof(stars) = 'integer' AND stars > 0)),
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
    telegram_charge_id TEXT,
    receipt_file_id TEXT,
    receipt_kind TEXT CHECK (receipt_kind IS NULL OR receipt_kind IN ('photo', 'document')),
    reviewed_by TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE UNIQUE INDEX top_ups_charge ON top_ups(telegram_charge_id) WHERE telegram_charge_id IS NOT NULL;
  CREATE INDEX top_ups_user_status ON top_ups(telegram_id, method, status);
  CREATE TABLE top_up_admin_messages (
    top_up_id INTEGER NOT NULL REFERENCES top_ups(id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    PRIMARY KEY (top_up_id, chat_id, message_id)
  );
` }, { version: 10, sql: `
  -- Блокировка пользователей администраторами.
  ALTER TABLE users ADD COLUMN banned_at TEXT;
  ALTER TABLE users ADD COLUMN banned_by TEXT;
  CREATE INDEX top_ups_pending ON top_ups(method, status, created_at, id);
` }];
export function migrateSchema(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > migrations.at(-1).version) throw new Error('База новее приложения: обновите код.');
    for (const migration of migrations) {
      if (migration.version <= version) continue;
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
// JSON участвует только в однократном импорте, не в работе бота.
export async function importLegacyUsers(db, file) {
  const marker = db.prepare("SELECT value FROM app_meta WHERE key = 'legacy_users_imported'");
  if (marker.get() || !file) return;
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const users = JSON.parse(text);
  if (!users || typeof users !== 'object' || Array.isArray(users)) throw new Error('users.json должен содержать объект.');
  const rows = Object.entries(users).map(([id, user]) => {
    if (!/^[1-9]\d*$/.test(id) || !user || typeof user !== 'object' || Array.isArray(user)) {
      throw new Error('Некорректная запись в users.json.');
    }
    const acceptedAt = user.acceptedAt ?? null;
    if (acceptedAt !== null && (typeof acceptedAt !== 'string' || !Number.isFinite(Date.parse(acceptedAt)))) {
      throw new Error(`Некорректная дата согласия пользователя ${id}.`);
    }
    const version = user.rulesVersion ?? (acceptedAt ? 1 : 0);
    if (!Number.isSafeInteger(version) || version < 0) throw new Error(`Некорректная версия правил пользователя ${id}.`);
    return [id, acceptedAt, version];
  });
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!marker.get()) {
      const insert = db.prepare(`INSERT INTO users (telegram_id, accepted_at, rules_version) VALUES (?, ?, ?)
        ON CONFLICT (telegram_id) DO NOTHING`);
      for (const row of rows) insert.run(...row);
      db.prepare("INSERT INTO app_meta (key, value) VALUES ('legacy_users_imported', ?)").run(new Date().toISOString());
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

// Добавляем начальный каталог один раз: ручные изменения цен не перезаписываются.
export function seedInitialCatalog(db) {
  const marker = db.prepare("SELECT value FROM app_meta WHERE key = 'catalog_seed_v1'");
  if (marker.get()) return;
  const products = [
    // Цены в рублях.
    ['dagestan-private', 'Дагестанская Приватка', 299, 389],
    ['ingush-private', 'Ингушская Приватка', 349, 499],
    ['chechen-private', 'Чеченская Приватка', 499, 799],
    ['covered', 'Покрытые', 549, 729],
    ['everything', 'Всё сразу', 1349, 1999],
  ];
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!marker.get()) {
      const findBySlug = db.prepare('SELECT id FROM products WHERE slug = ?');
      const findByTitle = db.prepare('SELECT id FROM products WHERE title = ? ORDER BY id LIMIT 1');
      const insert = db.prepare(`INSERT INTO products
        (slug, title, description, price, original_price, currency, is_active, sort_order)
        VALUES (?, ?, '', ?, ?, 'RUB', 1, ?)
        ON CONFLICT(slug) WHERE slug IS NOT NULL DO NOTHING`);
      const update = db.prepare(`UPDATE products SET slug = ?, title = ?, price = ?,
        original_price = ?, currency = 'RUB', is_active = 1, sort_order = ? WHERE id = ?`);
      products.forEach(([slug, title, price, original], index) => {
        const existing = findBySlug.get(slug) ?? findByTitle.get(title);
        if (existing) update.run(slug, title, price, original, index, existing.id);
        else insert.run(slug, title, price, original, index);
      });
      db.prepare("INSERT INTO app_meta (key, value) VALUES ('catalog_seed_v1', ?)")
        .run(new Date().toISOString());
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}