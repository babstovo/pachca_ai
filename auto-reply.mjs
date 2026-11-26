import { isProjectManager } from './bugs.mjs';

function userMentioned(text, nickname) {
  if (!nickname) return false;
  const handle = nickname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}_@])@${handle}(?![\\p{L}\\p{N}_.-])`, 'iu').test(text);
}

export function mentionedUserIds(markup) {
  if (!Array.isArray(markup)) return [];
  return [...new Set(markup.filter(part => part?.style === 'mention' && part.attributes?.type === 'user' &&
    Number.isSafeInteger(part.attributes.id)).map(part => part.attributes.id))];
}

function mentionsProfile(message, profile) {
  return message.mention_ids?.includes(Number(profile.profile_id)) || userMentioned(message.text, profile.nickname);
}

export function potentiallyAddressed(message, profile) {
  return mentionsProfile(message, profile) || Number.isSafeInteger(message.parent_id);
}

export function humanAuthor(author) {
  return author && !(author.bot || author.is_bot || author.bot_id || author.type === 'bot' || author.kind === 'bot');
}

// Messages sent with a user's personal token still have an author to check.
export function isConversationMessage(record) {
  return (record.kind === undefined || record.kind === 0) && !record.deleted_at && !record.application &&
    (!record.source || record.source === 'personal_token');
}

// A full recent page can omit the owner's earlier replies from the same day.
export function firstMessageToday(records, ownerId, pageSize, now = new Date()) {
  if (!Array.isArray(records)) return false;
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const previousDayReached = records.some(row => Date.parse(row.created_at) < midnight);
  return (records.length < pageSize || previousDayReached) && !records.some(row =>
    row.user_id === ownerId && isConversationMessage(row) && !(Date.parse(row.created_at) < midnight));
}

export async function addressedToOwner(get, message, profile, burst = []) {
  const [chats, authors] = await Promise.all([
    get('/chats', { ids: [message.chat_id] }), get('/users', { ids: [message.author_id] }),
  ]);
  const author = authors?.data?.find(user => user.id === message.author_id);
  if (!humanAuthor(author) && !isProjectManager(author)) return false;
  if (chats?.records?.some(chat => chat.id === message.chat_id && chat.personal === true)) return true;
  const messages = [message, ...burst];
  if (messages.some(item => mentionsProfile(item, profile))) return true;
  const ids = [...new Set(messages.map(item => item.parent_id).filter(Number.isSafeInteger))];
  if (!ids.length) return false;
  const parents = await get('/messages', { ids });
  return parents.some(record => ids.includes(record.id) && record.chat_id === message.chat_id && record.user_id === profile.profile_id);
}

// History is chronological. Ignore casing, decoration and task numbers when
// comparing wording, but always return the complete original candidate.
export function chooseReplyWording(history, candidates) {
  const key = text => text.toLowerCase().replace(/#\d+/gu, '#').match(/[\p{L}\p{N}]+/gu)?.join(' ') || text.trim();
  const sent = history.filter(row => row.owner).map(row => key(row.text));
  let oldest = Infinity;
  let oldestOpening = Infinity;
  let choice = candidates[0];
  for (const candidate of candidates) {
    const wording = key(candidate);
    const last = sent.lastIndexOf(wording);
    const opening = wording.split(' ').slice(0, 2).join(' ') + ' ';
    const lastOpening = sent.findLastIndex(previous => (previous + ' ').startsWith(opening));
    if (last < oldest || (last === oldest && lastOpening < oldestOpening)) {
      choice = candidate;
      oldest = last;
      oldestOpening = lastOpening;
    }
    if (last === -1 && lastOpening === -1) break;
  }
  return choice;
}

export function replyDecision(output, history = []) {
  const data = JSON.parse(output);
  if (data?.action === 'review_task') return {action:'review_task'};
  if (data?.action === 'skip') {
    const reason = typeof data.reason === 'string' ? data.reason.trim().slice(0, 180) : '';
    return reason ? { action: 'skip', reason } : { action: 'skip' };
  }
  if (data?.action === 'check' && ['git', 'tasks', 'both'].includes(data.scope)) return { action: 'check', scope: data.scope };
  if (!['reply', 'ask', 'image'].includes(data?.action) || typeof data.text !== 'string' || !data.text.trim() || data.text.length > 1500) {
    throw new Error('Codex вернул решение в неожиданном формате. Ответ требует проверки.');
  }
  const primary = data.text.trim();
  const alternatives = data.action === 'reply' && Array.isArray(data.alternatives)
    ? data.alternatives.slice(0, 2).filter(text => typeof text === 'string' && text.trim() && text.length <= 1500).map(text => text.trim())
    : [];
  return { action: data.action, text: chooseReplyWording(history, [primary, ...alternatives]) };
}

const transliteration = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };

export function normalizedName(value) {
  return String(value ?? '').normalize().toLowerCase().replace(/[а-яё]/g, letter => transliteration[letter])
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function speakerNames(user) {
  const display = normalizedName(user?.name);
  const full = normalizedName([user?.first_name, user?.last_name].filter(Boolean).join(' '));
  return [display, full, display.split(' ')[0], normalizedName(user?.first_name), normalizedName(user?.nickname)].filter(Boolean);
}

export function keepOwnerQuestion(decision, owner, correspondent) {
  if (decision.action !== 'reply') return decision;
  const text = decision.text;
  const privateLabel = /^(?:(?:вопрос|уточнение)\s+(?:(?:к|для)\s+)?владельц|(?:надо|нужно)\s+(?:спросить|уточнить)\s+у\s+владельц|owner\s+(?:question|clarification))/iu;
  if (privateLabel.test(text)) return { ...decision, action: 'ask' };
  // Routing a delegated message is a decision for the owner, even when the
  // model phrases it as a question without addressing the owner by name.
  const routingQuestion = /(?:кому\s+(?:(?:мне|именно|нужно|надо|всё-таки)\s+)*(?:адресовать|отправить|переслать|написать)|в\s+какой\s+чат\s+(?:мне\s+)?(?:отправить|написать)|кого\s+(?:выбрать|указать)\s+получателем|кто\s+(?:указан\s+)?получатель|who\s+should\s+I\s+(?:send|address))/iu;
  if (routingQuestion.test(text)) return { ...decision, action:'ask' };
  if (!/[?？]|(?:^|\s)(?:подскажи|уточни|скажи|please)(?!\p{L})/iu.test(text)) return decision;
  const address = text.match(/^(?:(?:привет|hi|hello)[,!\s]+)?[«"“]*(@?[\p{L}\p{N}_.-]+(?:\s+[\p{L}\p{N}_.-]+){0,2})\s*[,!:—]/iu);
  if (!address) return decision;
  const name = normalizedName(address[1]);
  return speakerNames(owner).includes(name) && !speakerNames(correspondent).includes(name)
    ? { ...decision, action: 'ask' } : decision;
}

export async function routeAgentReply(decision, context, classify, signal) {
  const routed = keepOwnerQuestion(decision, context.owner, context.sender);
  if (routed.action !== 'reply') return routed;
  try {
    const audience = (await classify(context, routed.text)).trim();
    signal?.throwIfAborted();
    if (audience === 'recipient') return routed;
  } catch {
    signal?.throwIfAborted();
  }
  return {...routed, action:'ask'};
}

export function latestIncoming(recent, message) {
  return Array.isArray(recent) && recent.some(item => item.id === message.id && !item.deleted_at &&
    String(item.text ?? '').slice(0, 2400) === message.text) && !recent.some(item => item.id > message.id &&
      item.user_id === message.author_id);
}

export function needsReply(recent, message, profileId) {
  return latestIncoming(recent, message) && !recent.some(item => item.id > message.id && item.user_id === profileId);
}

export function imageQuestion(burst) {
  const caption = burst.map(item => item.text.trim()).filter(Boolean).join(' ').slice(0, 240);
  return caption ? `Что ответить на изображение с подписью «${caption}»?` : 'Собеседник прислал изображение. Что ответить?';
}

export function replyBurst(recent, target) {
  const prior = recent.filter(row => row.id <= target.id && isConversationMessage(row)).sort((a, b) => b.id - a.id);
  const messages = [];
  let nextTime;
  for (const row of prior) {
    if (row.user_id !== target.author_id || messages.length >= 12) break;
    const time = Date.parse(row.created_at);
    if (nextTime - time > 20 * 60_000) break;
    nextTime = time;
    if (target.parent_id && row.parent_message_id && row.parent_message_id !== target.parent_id) break;
    messages.push({ id: row.id, text: String(row.text ?? '').slice(0, 1000), parent_id: row.parent_message_id,
      mention_ids: mentionedUserIds(row.markup),
      attachments: Boolean(row.files?.length || row.sticker || row.voice_content),
      image: Boolean(row.files?.some(file => file.file_type === 'image')) });
  }
  return messages.reverse();
}
