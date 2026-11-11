import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import {
  DEFAULT_PLATFORM_OPTIONS,
  type PlatformOptions,
} from '../../../packages/classroom-settings/schema';
import { request } from './api';
import i18n from './i18n';
const Context = createContext({ options: DEFAULT_PLATFORM_OPTIONS, reload: async () => {} });
export function PlatformOptionsProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<PlatformOptions>(DEFAULT_PLATFORM_OPTIONS);
  const reload = useCallback(async () => {
    try {
      const data = await request<{ options: PlatformOptions }>('/app/settings', undefined, {
        silent: true,
      });
      setOptions(data.options);
    } catch {}
  }, []);
  useEffect(() => {
    void reload();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, 60000);
    window.addEventListener('focus', reload);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', reload);
    };
  }, [reload]);
  useEffect(() => {
    document.title = options.siteName;
    if (!localStorage.getItem('language')) void i18n.changeLanguage(options.defaultLanguage);
  }, [options.siteName, options.defaultLanguage]);
  return <Context.Provider value={{ options, reload }}>{children}</Context.Provider>;
}
export const usePlatformOptions = () => useContext(Context);
