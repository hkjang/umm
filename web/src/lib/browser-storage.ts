export type StorageRead = { available: true; value: string | null } | { available: false; value: null };

type BrowserStorageName = 'localStorage' | 'sessionStorage';

function readStorage(name: BrowserStorageName, key: string): StorageRead {
  try {
    return { available: true, value: window[name].getItem(key) };
  } catch {
    return { available: false, value: null };
  }
}

function writeStorage(name: BrowserStorageName, key: string, value: string): boolean {
  try {
    window[name].setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeStorage(name: BrowserStorageName, key: string): boolean {
  try {
    window[name].removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export const readLocalStorage = (key: string) => readStorage('localStorage', key);
export const writeLocalStorage = (key: string, value: string) => writeStorage('localStorage', key, value);
export const removeLocalStorage = (key: string) => removeStorage('localStorage', key);
export const readSessionStorage = (key: string) => readStorage('sessionStorage', key);
export const writeSessionStorage = (key: string, value: string) => writeStorage('sessionStorage', key, value);
