import { useEffect, useState } from 'react';
import { LanguageContext } from './LanguageContext';
import { translations } from './i18n-data';

export function LanguageProvider({ children }) {
  const [locale, setLocale] = useState(() => {
    try {
      const saved = localStorage.getItem('ashkan-board-locale');
      return saved === 'en' ? 'en' : 'fa';
    } catch {
      return 'fa';
    }
  });

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'fa' ? 'rtl' : 'ltr';
    try {
      localStorage.setItem('ashkan-board-locale', locale);
    } catch {
      // LocalStorage disabled gracefully.
    }
  }, [locale]);

  const t = (key, values = {}) => {
    let value = translations[locale][key] ?? translations.en[key] ?? key;
    Object.entries(values).forEach(([name, replacement]) => {
      value = value.replace(`{{${name}}}`, String(replacement));
    });
    return value;
  };

  return (
    <LanguageContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </LanguageContext.Provider>
  );
}
