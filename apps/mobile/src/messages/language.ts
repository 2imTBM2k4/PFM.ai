export let activeLanguage: 'vi' | 'en' = 'vi';

export function setActiveLanguage(language: 'vi' | 'en'): void {
  activeLanguage = language;
}
