import yauzl from 'yauzl';
import { promisify } from 'node:util';
import { readLimitedBytes } from './link-preview.mjs';

export async function officePictures(bytes,visit,include = ()=>true) {
  const zip = await promisify(yauzl.fromBuffer)(bytes,{lazyEntries:true});
  let count = 0, remaining = 16*1024*1024;
  try {
    await new Promise((resolve,reject)=>{
      zip.once('error',reject).once('end',resolve).on('entry',async entry=>{
        try {
          if (/^word\/media\/[^/]+\.(?:png|jpe?g|webp|gif)$/i.test(entry.fileName) &&
              count < 8 && entry.uncompressedSize <= remaining && include(entry.fileName.slice('word/media/'.length))) {
            const stream = await promisify(zip.openReadStream.bind(zip))(entry);
            const picture = await readLimitedBytes(stream,remaining);
            remaining -= picture.length;
            await visit(entry.fileName.slice('word/media/'.length),picture);
            count++;
          }
          zip.readEntry();
        } catch (error) { reject(error); }
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
}

export async function officeText(bytes, page, {pictureReferences=false} = {}) {
  const zip = await promisify(yauzl.fromBuffer)(bytes, {lazyEntries:true});
  const parts = {};
  let total = 0;
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject).on('end', resolve).on('entry', async entry => {
        try {
          if (/^(word\/document|xl\/sharedStrings|xl\/worksheets\/sheet\d+)\.xml$/.test(entry.fileName) ||
              (pictureReferences && entry.fileName === 'word/_rels/document.xml.rels')) {
            total += entry.uncompressedSize;
            if (total > 16 * 1024 * 1024) throw new Error('Документ слишком велик для предпросмотра.');
            const stream = await promisify(zip.openReadStream.bind(zip))(entry);
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            parts[entry.fileName] = Buffer.concat(chunks).toString('utf8');
          }
          zip.readEntry();
        } catch (error) { reject(error); }
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
  return page.evaluate(({parts,pictureReferences}) => {
    const xml = key => new DOMParser().parseFromString(parts[key], 'application/xml');
    const tags = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));
    const text = node => tags(node,'t').map(t => t.textContent).join('');
    if (parts['word/document.xml']) {
      const paragraphs = tags(xml('word/document.xml'),'p');
      if (!pictureReferences) return paragraphs.map(text).join('\n').slice(0,24000);
      const targets = new Map();
      if (parts['word/_rels/document.xml.rels']) for (const rel of tags(xml('word/_rels/document.xml.rels'),'Relationship')) {
        const target = rel.getAttribute('Target') || '';
        const match = /^(?:\/word\/|\.\/)?media\/([^/]+)$/i.exec(target);
        if (match && rel.getAttribute('TargetMode') !== 'External') targets.set(rel.getAttribute('Id'),match[1]);
      }
      return paragraphs.map(p=>({text:text(p),pictures:[...tags(p,'blip'),...tags(p,'imagedata')].flatMap(node=>{
        const ref = [...node.attributes].find(a=>a.localName==='embed' || a.localName==='id');
        return targets.has(ref?.value) ? [targets.get(ref.value)] : [];
      })}));
    }
    const strings = parts['xl/sharedStrings.xml'] ? tags(xml('xl/sharedStrings.xml'),'si').map(text) : [];
    const rows = [];
    for (const sheet of Object.keys(parts).filter(key => key.startsWith('xl/worksheets/'))) {
      for (const row of tags(xml(sheet),'row')) {
        rows.push(tags(row,'c').map(cell => {
          const value = tags(cell,'v')[0]?.textContent;
          return cell.getAttribute('t') === 's' ? strings[Number(value)] : value ?? text(cell);
        }).join('\t'));
      }
    }
    return rows.join('\n').slice(0,24000);
  }, {parts,pictureReferences});
}
