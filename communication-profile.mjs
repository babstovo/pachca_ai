import { readFile, rename, writeFile } from 'node:fs/promises';

const limits = { description: 4000, style: 2000, rules: 4000 };
export function normalizeCommunicationProfile(input) {
  return Object.fromEntries(Object.entries(limits).map(([key, limit]) => {
    const value = input?.[key] ?? '';
    if (typeof value !== 'string' || value.length > limit) throw new Error(`Поле должно содержать не больше ${limit} символов.`);
    return [key, value.trim()];
  }));
}

export async function readCommunicationProfile(file) {
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    return normalizeCommunicationProfile(saved);
  } catch (error) {
    if (error.code === 'ENOENT') return normalizeCommunicationProfile();
    throw error;
  }
}

export async function saveCommunicationProfile(file, input) {
  const profile = normalizeCommunicationProfile(input);
  await writeFile(`${file}.tmp`, JSON.stringify(profile), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
  return profile;
}
