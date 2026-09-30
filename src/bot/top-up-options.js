// Суммы в целых рублях. Единый список для клавиатуры и проверки callback.
export const TOP_UP_AMOUNTS = Object.freeze([249, 349, 499, 799, 1499]);
// Курс Telegram Stars: сколько рублей стоит одна звезда.
export const RUB_PER_STAR = 1.3;

export function isTopUpAmount(amount) {
  return Number.isSafeInteger(amount) && TOP_UP_AMOUNTS.includes(amount);
}

// Цена в звёздах: сумма / курс, округление вверх. Считаем в сотых, чтобы не ловить погрешность float.
export function starsForRub(amount) {
  if (!Number.isSafeInteger(amount) || amount < 1) throw new TypeError('Некорректная сумма.');
  const rateCents = Math.round(RUB_PER_STAR * 100);
  return Math.floor((amount * 100 + rateCents - 1) / rateCents);
}