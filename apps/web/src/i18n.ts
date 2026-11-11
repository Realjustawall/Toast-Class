import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en';
import fa from './locales/fa';
const faTranslation: typeof en = fa;
void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, fa: { translation: faTranslation } },
  lng: localStorage.getItem('language') ?? 'fa',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});
export default i18n;
