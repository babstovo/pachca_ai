import { readFile, rename, writeFile } from 'node:fs/promises';

const words = text => String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const timeSensitive = /\b\d{1,2}[.:/]\d{1,2}\b|(?:^|[^\p{L}])(?:сегодня|завтра|послезавтра|вчера|сейчас|понедельник\p{L}*|вторник\p{L}*|сред[ауеы]|четверг\p{L}*|пятниц\p{L}*|суббот\p{L}*|воскресень\p{L}*|today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?!\p{L})/iu;

async function entries(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

let writes = Promise.resolve();

export async function rememberReply(file, example) {
  if (!Number.isSafeInteger(example.author) || !words(example.question).length || !example.reply?.trim()) return;
  const write = writes.then(async () => {
    const question = words(example.question).join(' ');
    const previous = (await entries(file)).filter(item => !(item.profile === example.profile && item.chat === example.chat &&
      item.author === example.author && words(item.question).join(' ') === question &&
      (!item.clarification || item.clarification === example.clarification)));
    await writeFile(`${file}.tmp`, JSON.stringify([...previous.slice(-149), example]), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  });
  writes = write.catch(() => {});
  return write;
}

export async function relatedReplies(file, profile, message, select) {
  const query = words(message.text);
  if (!query.length) return [];
  const candidates = (await entries(file)).filter(item => item.profile === profile && item.chat === message.chat_id &&
    item.author === message.author_id && item.reply?.trim() &&
    ![item.question,item.reply,item.guidance,item.clarification].some(value => timeSensitive.test(value)))
    .reverse().map(item => ({
      question: item.question.slice(0, 2400), clarification: item.clarification?.slice(0, 1500),
      guidance: item.guidance?.slice(0, 1500), reply: item.reply.slice(0, 1500),
      ...(item.delegated ? {delegated:true} : {}),
    }));
  // For a short history the reply model can compare the cases in its existing turn.
  if (candidates.length <= 6) return candidates;
  if (select) {
    const topics = candidates.map(({ question, clarification }, id) => ({id, question:question.slice(0,500), clarification:clarification?.slice(0,250)}));
    const selected = await select(topics);
    if (Array.isArray(selected)) {
      return [...new Set(selected)].filter(id => Number.isInteger(id) && id >= 0 && id < candidates.length)
        .sort((a,b) => a-b).slice(0,6).map(id => candidates[id]);
    }
  }
  const tokens = new Set(query);
  return candidates.map((item,id) => {
    const old = new Set(words(item.question));
    const score = [...old].filter(word => tokens.has(word)).length / new Set([...old,...tokens]).size;
    return {id,score};
  }).sort((a,b) => b.score-a.score).slice(0,6).sort((a,b) => a.id-b.id).map(({id}) => candidates[id]);
}
