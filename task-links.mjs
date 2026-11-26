import { configuredBoard } from './workspace-settings.mjs';
const taskWord = /(?<![\p{L}\p{N}])(?:задач(?:а|у|е|ей|и)|карточк(?:а|у|е|и)|work package|task|ticket)(?![\p{L}\p{N}])/iu;

export function urlTask(value) {
  return taskIdAtOrigin(value, configuredBoard()?.origin);
}

function taskIdAtOrigin(value, origin) {
  let url;
  try { url = new URL(value); } catch { return; }
  if (url.origin !== origin || url.username || url.password) return;
  const match = /^\/(?:projects\/[^/]+\/)?(?:work_packages\/(?:details\/)?|boards\/\d+\/details\/)([1-9]\d{0,11})(?:\/(?:activity|details|relations|watchers))?\/?$/u.exec(url.pathname);
  return match ? Number(match[1]) : undefined;
}

// Pachca's native link marks use exclusive UTF-16 offsets into the final text.
export function formatTaskLinks(input) {
  const openProjectOrigin = configuredBoard()?.origin;
  const tokens = /```[\s\S]*?(?:```|$)|`[^`\n]*`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<>()«»]+|(?<![\p{L}\p{N}_])([#№])\s*([1-9]\d{0,11})(?![\p{L}\p{N}_])|(?<=задач[аеуи] |карточк[аеуи] |task )[1-9]\d{0,11}(?![\p{L}\p{N}_])/giu;
  let text = '', end = 0;
  const markup = [], ids = new Set();
  for (const match of input.matchAll(tokens)) {
    text += input.slice(end,match.index);
    end = match.index + match[0].length;
    const token = match[0];
    let id, suffix = '';
    if (match[2]) id = taskIdAtOrigin(match[2], openProjectOrigin);
    else if (/^https?:/iu.test(token)) {
      suffix = token.match(/[.,!?;:]+$/u)?.[0] || '';
      id = taskIdAtOrigin(token.slice(0,token.length-suffix.length), openProjectOrigin);
    } else if (match[4]) {
      const before = input.slice(0,match.index);
      if (!(match[3] === '№' && !taskWord.test(input) && !/OpenProject/iu.test(input) && input.trim() !== token) &&
          !/(?:цвет|color|заказ[аеу]?|сч[её]т[аеу]?|чат[аеу]?|сообщени[ея]|PR|issue)\s*$/iu.test(before)) id = Number(match[4]);
    } else if (/^\d/u.test(token)) id = Number(token);
    if (!id || !openProjectOrigin) { text += token; continue; }
    const start = text.length;
    text += '#'+id;
    markup.push({style:'link',start,end:text.length,attributes:{url:openProjectOrigin+'/work_packages/'+id+'/activity'}});
    text += suffix; ids.add(id);
  }
  return {text:text+input.slice(end),markup,ids:[...ids]};
}

function stem(word) {
  return word.toLowerCase().replace(/(?:иями|ями|ами|ов|ах|ях|ей|ой|ом|ем|ам|ям|ы|и|у|а|е|я)$/u,'');
}

// Search only for an existing task described by topic, e.g. «задача с ценами товаров».
export function taskTopic(text) {
  const match = /(?<!\p{L})(?:задач[ауеи]|задачей|карточк[ауеи])\s+(?:(?:по|про|для|об?|с|со|на)\s+|[«"])([^.,;:!?\n»"]+)/iu.exec(text);
  if (!match || /(?:создай(?:те)?|создать|заведи(?:те)?|завести|поставь(?:те)?|новую)\s+(?:новую\s+)?$/iu.test(text.slice(0,match.index))) return [];
  const phrase = match[1].split(/\s+(?:(?:в|на)\s+тестировани|и\s+|уже\s+|нужно\s+|надо\s+|был[аио]?\s+|перев[её]д|перев[её]л|пере[шх]|отправ|готов|наход|закры|откры|добав|ушл|жд[её]т|можно|провер)/iu)[0];
  return [...new Set((phrase.toLowerCase().match(/[\p{L}\d-]{3,}/gu) || [])
    .map(stem)
    .filter(word => word.length >= 3))].slice(0,5);
}

export function chooseTask(terms,candidates,context = '') {
  const specific = terms.filter(term => !['товар','игр','проект'].includes(term));
  const matches = candidates.map(task => {
    const words = (task.subject.match(/[\p{L}\d-]+/gu) || []).map(stem);
    const score = specific.every(term => words.includes(term)) ? terms.filter(term => words.includes(term)).length : 0;
    return {task,score};
  }).filter(row => row.score > 0).sort((a,b) => b.score-a.score);
  const best = matches.filter(row => row.score === matches[0].score).map(row => row.task);
  if (best.length > 1 && /(?:в|на)\s+тестировани[еи]/iu.test(context)) {
    const testing = best.filter(row => /test|тестир/iu.test(row.status || ''));
    if (testing.length) return testing;
  }
  return best;
}

export async function linkTaskMention(text,context,search) {
  if (!configuredBoard()) return text;
  const draft = formatTaskLinks(text);
  const given = formatTaskLinks(context || '').ids;
  const fromContext = taskTopic(context || '');
  if (draft.ids.length && ((!given.length && !fromContext.length) || draft.ids.every(id => given.includes(id)))) return draft.text;
  if (!draft.ids.length && !taskWord.test(text) && !/перев[её]л|переведен|в тестировани|в работу|на проверку|статус/iu.test(text)) return text;
  const terms = fromContext.length ? fromContext : taskTopic(text);
  let ids = given;
  if (!ids.length && terms.length) {
    const candidates = await search(terms);
    const best = chooseTask(terms,candidates,(context || '')+' '+text);
    if (best.length !== 1) {
      const choices = best.slice(0,5).map(task => '#'+task.id+' «'+task.subject+'»').join(', ');
      throw Error((choices ? 'Подходят несколько задач: '+choices+'. ' : 'Не нашёл задачу по этому описанию. ')+'Укажи номер OpenProject.');
    }
    ids = [best[0].id];
  }
  if (!ids.length) {
    if (/(?:эту|этой|данную|по)\s+задач[еу]|(?:перев[её]л[аи]?|закрыл[аи]?|проверил[аи]?)\s+задачу|задача\s+(?:переведена|закрыта|готова|в тестировании)/iu.test(text))
      throw Error('О какой задаче идёт речь? Укажи номер OpenProject или название.');
    return text;
  }
  if (draft.ids.length) {
    if (draft.ids.every(id => ids.includes(id))) return draft.text;
    if (draft.ids.length !== 1 || ids.length !== 1) throw Error('В черновике и поручении разные задачи. Укажи нужные номера OpenProject.');
    let fixed = draft.text;
    for (const mark of draft.markup.slice().reverse()) fixed = fixed.slice(0,mark.start)+'#'+ids[0]+fixed.slice(mark.end);
    return fixed;
  }
  const labels = ids.map(id => '#'+id).join(', ');
  return taskWord.test(text) ? text.replace(taskWord,word => word+' '+labels) : text+' ('+labels+')';
}
