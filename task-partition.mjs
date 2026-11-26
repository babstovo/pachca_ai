import { basename } from 'node:path';
import { selectTaskFolders } from './task-workspace.mjs';

const commonHeading = /^(?:проверка|проверки|критерии при[её]мки|тестирование|acceptance criteria|verification)\s*:?$/iu;
const sharedHeading = /^(?:общие требования|для всех проектов|для обоих проектов|shared requirements)\s*:?$/iu;
const terms = text => new Set((text.toLowerCase().match(/[\p{L}\d]{4,}/gu) || [])
  .map(w=>w.slice(0,4)).filter(w=>!['пров','прав','нужн','зада','разд','сдел','долж','обно','изме','доба','буде','кото','прим','пунк','такж','реал','треб','стра','прил'].includes(w)));

// Retain original chunks verbatim. Section context also assigns drawings in
// paragraphs that have no text, which are common in Google Docs exports.
export function projectPartition(card,settings,folders,folder) {
  if (folders.length < 2) return;
  const config = {...settings,folders};
  const vocabulary = new Map(folders.map(path=>[path,new Set()]));
  function explicit(text) {
    const selected = selectTaskFolders({description:text},config).folders;
    if (selected.length) return selected;
    const normalized = text.toLowerCase();
    return folders.filter(path=>{
      const label = settings.folderProjects?.[path]?.name;
      return label && normalized.includes(label.toLowerCase());
    });
  }
  function infer(text,direct=explicit(text)) {
    if (direct.length) return direct;
    const tokens = terms(text);
    const ranked = folders.map(path=>({path,score:[...tokens].filter(token=>
      vocabulary.get(path).has(token) && folders.every(other=>other===path || !vocabulary.get(other).has(token))).length}))
      .sort((a,b)=>b.score-a.score);
    return ranked[0].score && ranked[0].score > ranked[1].score ? [ranked[0].path] : [];
  }
  function route(input,initial,training=false) {
    const result = [];
    let section = initial, last = initial, sectionLevel = 0;
    const paragraphs = Array.isArray(input) ? input : String(input || '').split(/\r?\n/).map(text=>({text}));
    for (const {text,pictures=[]} of paragraphs) {
      if (!text.trim()) { result.push({text:'',pictures,owners:last}); continue; }
      const start = result.length;
      for (const line of text.split(/(?<=[.!?])(?<!\d\.)\s+(?=[А-ЯЁA-Z])|;\s+|,\s*(?:а\s+)?(?=(?:(?:в|на)\s+[\p{L}\d_-]+)\s)|\s+и\s+(?=(?:(?:в|на)\s+[\p{L}\d_-]+)\s)/u)) {
        const title = line.trim().replace(/^(?:#{1,6}\s+|\d+[.)]\s+|\*{2})/u,'').replace(/\*{2}$/u,'');
        const direct = explicit(title);
        const level = /^(#{1,6})\s+/u.exec(line.trim())?.[1].length || 0;
        const prefix = /^([^:]{1,70}):\s+\S/u.exec(title);
        const namedPrefix = prefix ? explicit(prefix[1]) : [];
        const heading = level || namedPrefix.length || /^\*\*.+\*\*:?$/u.test(line.trim()) ||
          (/^\d+[.)]\s+/u.test(line.trim()) && (direct.length || !section.length || /^(?:правки|требования|изменения|раздел)\s/iu.test(title))) ||
          (direct.length && title.split(/\s+/).length<=4 && !/[.!?]/.test(title) && !/^[-*]/.test(title));
        if (commonHeading.test(title)) {
          if (!level || !sectionLevel || level <= sectionLevel) section=[];
          last=section; continue;
        }
        if (sharedHeading.test(title)) { section=folders; sectionLevel=level; last=folders; continue; }
        if (heading) {
          const named = namedPrefix.length ? namedPrefix : infer(title,direct);
          if (named.length || (level && level <= sectionLevel)) {
            section = named;
            sectionLevel = level;
          }
        }
        let owners = section;
        if (namedPrefix.length) owners = namedPrefix;
        else if (direct.length === 1 || !section.length) owners = infer(title,direct);
        if (training && owners.length===1) for (const term of terms(title)) vocabulary.get(owners[0]).add(term);
        result.push({text:line,pictures:[],owners});
        last = owners;
      }
      if (pictures.length) {
        const paragraphOwners = result.slice(start);
        const same = paragraphOwners.every(chunk=>chunk.owners.length === last.length && chunk.owners.every(path=>last.includes(path)));
        result.push({text:'',pictures,owners:same ? last : []});
      }
    }
    return result;
  }
  route(card.description,[],true);
  const label = settings.folderProjects?.[folder]?.name || settings.folderDescriptions?.[folder] || basename(folder);
  return {
    label, folder, owners:infer,
    chunks:(text,initial=[])=>route(text,initial),
  };
}
