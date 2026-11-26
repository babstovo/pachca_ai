import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const origin = 'https://app.pachca.com';
const webVersion = '1.48.10';
const apiVersion = '3.14';

export class HttpError extends Error {
  constructor(status, path) {
    const hint = status === 401 ? ' Выполните login.' : '';
    super(`Пачка вернула HTTP ${status} для ${path}.${hint}`);
    this.status = status;
  }
}

export function webRequest(context) {
  return async (path, { query = {}, profileId, method = 'GET', body, multipart, discardResponse, version = apiVersion } = {}) => {
    const url = new URL(`/api/v3${path}`, origin);
    for (const [name, value] of Object.entries(query)) {
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(`${name}[]`, item);
      } else if (value !== undefined) {
        url.searchParams.set(name, value);
      }
    }

    const headers = {
      accept: 'application/json, text/plain',
      'web-version': webVersion,
      'x-version': version,
      platform: 'web',
      referer: `${origin}/`,
    };
    if (!multipart) headers['content-type'] = 'application/json';
    if (profileId !== undefined) headers['user-id'] = String(profileId);
    if (method !== 'GET') headers.origin = origin;

    const retryHint = method === 'GET' ? '' : ' Перед повтором проверьте результат в Пачке.';
    let response;
    try {
      response = await context.request.fetch(url.toString(), {
        method, headers, data: body, multipart, timeout: multipart ? 30_000 : 15_000, maxRedirects: 0,
      });
    } catch {
      throw new Error(`Не удалось получить ответ Пачки для ${path}.${retryHint}`);
    }

    try {
      const status = response.status();
      if (status >= 300 && status < 400) throw new HttpError(401, path);
      if (!response.ok()) throw new HttpError(status, path);
      if (discardResponse) return null;
      const text = await response.text();
      if (!text) {
        if (method === 'GET') throw new Error(`Пачка вернула пустой ответ для ${path}.`);
        return null;
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Пачка вернула ответ другого формата для ${path}.${retryHint}`);
      }
    } finally {
      await response.dispose();
    }
  };
}

export async function workspaces(request) {
  const response = await request('/workspaces');
  if (!Array.isArray(response?.data)) throw new Error('Формат ответа со списком пространств изменился.');
  const profiles = new Map();
  for (const account of response.data) {
    if (!Array.isArray(account.workspaces)) throw new Error('В ответе Пачки отсутствуют пространства.');
    for (const { profile, company } of account.workspaces) {
      if (!profile?.id) continue;
      profiles.set(String(profile.id), {
        profile_id: profile.id,
        workspace: company?.name,
        name: profile.name ?? [profile.first_name, profile.last_name].filter(Boolean).join(' '),
        nickname: profile.nickname,
      });
    }
  }
  return [...profiles.values()];
}

export function clientDataDir() {
  if (!process.env.LOCALAPPDATA) throw new Error('Клиенту нужен профиль пользователя Windows.');
  return join(process.env.LOCALAPPDATA, 'PachcaWebClient');
}

export async function openSession(interactive = false, profileFolder = 'profile', options = {}) {
  const profilePath = join(clientDataDir(), profileFolder);
  const deadline = Date.now() + 8_000;
  for (;;) {
    try {
      return await chromium.launchPersistentContext(profilePath, {
        channel: 'msedge', headless: !interactive, chromiumSandbox: true, timeout: 15_000, ...options,
      });
    } catch (error) {
      const reason = error.message;
      if (/profile.*in use|SingletonLock|ProcessSingleton|profile appears|Opening in existing browser session/i.test(reason)) {
        if (!interactive && Date.now() < deadline) {
          await delay(350);
          continue;
        }
        throw new Error('Профиль клиента занят. Дождитесь завершения другой команды или закройте окно входа.');
      }
      if (/executable.*not|distribution.*not found/i.test(reason)) throw new Error('Установите Microsoft Edge.');
      throw new Error('Не удалось открыть отдельный профиль Edge.');
    }
  }
}

export async function login(context) {
  const [page] = context.pages();
  const tab = page ?? await context.newPage();
  await tab.goto(origin, { waitUntil: 'domcontentloaded', timeout: 25_000 });
  const request = webRequest(context);
  const deadline = Date.now() + 5 * 60_000;
  while (!tab.isClosed() && Date.now() < deadline) {
    try {
      const profiles = await workspaces(request);
      if (profiles.length) return profiles;
    } catch (error) {
      if (tab.isClosed()) break;
      if (![401, 403].includes(error.status)) throw error;
    }
    await delay(3_000);
  }
  throw new Error('Окно входа закрыто или истекло время ожидания.');
}
