import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const maxBytes = 4 * 1024 * 1024;
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

// Use only the trusted thread.started ID from this generation, never a path from model text.
export async function generatedThreadImage(thread, codexDir = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(thread)) throw Error('Codex не вернул ID генерации.');
  const folder = join(codexDir,'generated_images',thread);
  const files = await readdir(folder,{withFileTypes:true}).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const outputs = files.filter(f => f.isFile() && f.name.endsWith('.png'));
  if (outputs.length !== 1) throw Error('Codex не вернул одну готовую картинку.');
  const path = join(folder,outputs[0].name);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 12 * 1024 * 1024) throw Error('Слишком большой файл изображения.');
  const bytes = await readFile(path);
  if (bytes.length < 33 || !bytes.subarray(0,png.length).equals(png)) throw Error('Codex вернул неподдерживаемое изображение.');
  return {name:'Иллюстрация.png',bytes,width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
}

export function clipboardImages(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 3) throw new Error('Можно добавить до трёх картинок.');
  return input.map((base64, index) => {
    if (typeof base64 !== 'string' || base64.length > Math.ceil(maxBytes / 3) * 4) {
      throw new Error('Картинка должна занимать не больше 4 МБ.');
    }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > maxBytes) throw new Error('Картинка должна занимать не больше 4 МБ.');
    if (bytes.length < 33 || !bytes.subarray(0, png.length).equals(png)) throw new Error('Вложение должно быть картинкой PNG.');
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (!width || !height || width * height > 25_000_000) throw new Error('Слишком большие размеры картинки.');
    return { bytes, width, height, name: `Картинка-${index + 1}.png` };
  });
}

export async function withImageFiles(images, run) {
  if (!images.length) return run([]);
  const directory = await mkdtemp(join(tmpdir(), 'pachca-images-'));
  try {
    const paths = [];
    for (const { name, bytes } of images) {
      const path = join(directory, name);
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      paths.push(path);
    }
    return await run(paths);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

export function htmlAttachment(value) {
  const name = value?.name, html = value?.html;
  if (typeof name !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,100}\.html$/iu.test(name) ||
      typeof html !== 'string' || !/^\s*(?:<!doctype html>\s*)?<html[\s>]/iu.test(html) ||
      !/<\/html>\s*$/iu.test(html) || Buffer.byteLength(html) > 512 * 1024)
    throw Error('Не удалось подготовить полный HTML-файл для вложения.');
  return {name,bytes:Buffer.from(html,'utf8')};
}

export async function uploadImage(api, image) {
  return uploadFile(api,image,'image/png');
}

export async function uploadFile(api, { bytes, name, width, height }, mimeType) {
  const image = mimeType === 'image/png';
  const dimensions = image ? {width,height} : {};
  const metadata = { ...dimensions, name, size: bytes.length };
  const upload = await api('/uploads', { method: 'POST', body: {
    filename: name, size: metadata.size, ...dimensions, content_type: mimeType,
  } });
  const key = upload?.upload_uuid;
  if (typeof key !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(key)) {
    throw new Error('Пачка не создала загрузку файла.');
  }
  const path = `/uploads/${key}/content`;
  const multipart = upload.upload_url === `/api/v3${path}`;
  if (multipart && upload.strategy?.includes('upload_url')) {
    await api(path, { method: 'PUT', multipart: { file: { name, mimeType, buffer: bytes } }, discardResponse: true });
  } else {
    const storage = upload.presigned_upload;
    const route = upload.strategy?.find(method => ['presigned_upload', 'proxy_s3_url'].includes(method));
    const address = route === 'proxy_s3_url' ? storage?.proxy_s3_url : storage?.url;
    if (!route || !address) throw new Error('Пачка не предоставила адрес загрузки файла.');
    const url = new URL(address);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Пачка вернула неверный адрес загрузки.');
    const headers = new Headers(storage.headers ?? {});
    headers.delete('cookie');
    headers.delete('authorization');
    const response = await fetch(url, { method: 'PUT', headers, body: bytes, redirect: 'error', signal: AbortSignal.timeout(30_000) })
      .catch(() => { throw new Error('Соединение для загрузки файла прервалось.'); });
    await response.body?.cancel();
    if (!response.ok && response.status !== 412) throw new Error(`Хранилище Пачки вернуло HTTP ${response.status}.`);
    await api(`/uploads/${key}/complete`, { method: 'POST', discardResponse: true });
  }
  return { key, file_type: image ? 'image' : 'file', ...metadata };
}
