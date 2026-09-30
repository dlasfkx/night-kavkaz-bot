// Только новые ID пользователя, всегда строки (они превышают точность Number).
// id: null означает обычный эмодзи без кастомной замены.
export const EMOJI = Object.freeze({
  check: Object.freeze({ id: '5219899949281453881', fallback: '✅' }),
  lightning: Object.freeze({ id: '5219943216781995020', fallback: '⚡' }),
  heart: Object.freeze({ id: '5222400230133081714', fallback: '❤️' }),
  fire: Object.freeze({ id: '5222148368955877900', fallback: '🔥' }),
  warning: Object.freeze({ id: '5220197908342648622', fallback: '❗' }),
  question: Object.freeze({ id: '5220053623211305785', fallback: '❓' }),
  eyes: Object.freeze({ id: '5220070652756635426', fallback: '👀' }),
  ellipsis: Object.freeze({ id: '5220046725493828505', fallback: '💬' }),
  profile: Object.freeze({ id: '5364052602357044385', fallback: '👤' }),
  cart: Object.freeze({ id: '5258024802010026053', fallback: '🛒' }),
  diamond: Object.freeze({ id: '5343636681473935403', fallback: '💎' }),
  hourglass: Object.freeze({ id: '5258113901106580375', fallback: '⌛' }),
  lock: Object.freeze({ id: '5393302369024882368', fallback: '🔒' }),
  fingerprint: Object.freeze({ id: '5301096984617166561', fallback: '🆔' }),
  folder: Object.freeze({ id: '5341492148468465410', fallback: '📁' }),
  star: Object.freeze({ id: '5310224206732996002', fallback: '⭐' }),
  bullet: Object.freeze({ id: '5294096239464295059', fallback: '🔹' }),
  back: Object.freeze({ id: '5348276504579031076', fallback: '↩️' }),
  cancel: Object.freeze({ id: '5348402067947929537', fallback: '❌' }),
  // Впишите ID кастомного эмодзи карточки вместо null.
  card: Object.freeze({ id: '5283232570660634549', fallback: '💳' }),
  link: Object.freeze({ id: '5454419255430767770', fallback: '🔗' }),
});
const BUTTON_STYLES = new Set(['success', 'danger', 'primary']);
export function emoji(name) {
  if (!EMOJI[name]) throw new TypeError(`Неизвестный эмодзи: ${name}`);
  return EMOJI[name];
}
function buttonStyle(style) {
  if (style !== undefined && !BUTTON_STYLES.has(style)) throw new TypeError(`Неизвестный стиль кнопки: ${style}`);
  return style;
}
// style: 'success' (зелёная), 'danger' (красная), 'primary' (синяя).
export function button(text, data, { icon, style } = {}) {
  if (!data || Buffer.byteLength(data, 'utf8') > 64) throw new TypeError('Некорректный callback_data.');
  return { text, data, icon: icon ? emoji(icon) : undefined, style: buttonStyle(style) };
}
export function urlButton(text, url, { icon, style } = {}) {
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) throw new TypeError('Некорректная ссылка кнопки.');
  return { text, url, icon: icon ? emoji(icon) : undefined, style: buttonStyle(style) };
}
// Форматирование через entities, без HTML и интерпретации пользовательского имени.
export function bold(text) {
  return { type: 'bold', text: String(text) };
}
export function strikethrough(text) {
  return { type: 'strikethrough', text: String(text) };
}
// Моноширинный текст: в Telegram копируется по нажатию.
export function code(text) {
  return { type: 'code', text: String(text) };
}
export function renderScreen(screen, customEmojiEnabled = true) {
  let text = '';
  const entities = [];
  for (const part of screen.parts) {
    if (typeof part === 'string') text += part;
    else if (part.type === 'bold' || part.type === 'strikethrough' || part.type === 'code') {
      if (part.text.length) entities.push({ type: part.type, offset: text.length, length: part.text.length });
      text += part.text;
    }
    else {
      if (customEmojiEnabled && part.id) entities.push({ type: 'custom_emoji', offset: text.length,
        length: part.fallback.length, custom_emoji_id: part.id });
      text += part.fallback;
    }
  }
  return { text, extra: {
    ...(entities.length ? { entities } : {}),
    reply_markup: { inline_keyboard: (screen.rows ?? []).map(row => row.map(item => ({
      text: item.icon && (!customEmojiEnabled || !item.icon.id) ? `${item.icon.fallback} ${item.text}` : item.text,
      ...(item.url ? { url: item.url } : { callback_data: item.data }),
      // Цвет задаётся только там, где он явно указан; остальные кнопки обычные.
      ...(item.style ? { style: item.style } : {}),
      ...(customEmojiEnabled && item.icon?.id ? { icon_custom_emoji_id: item.icon.id } : {}),
    }))) },
  } };
}