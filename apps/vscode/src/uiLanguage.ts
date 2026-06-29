export const UI_LANGUAGES = ["en", "ko"] as const;

export type UiLanguage = (typeof UI_LANGUAGES)[number];

export const DEFAULT_UI_LANGUAGE: UiLanguage = "en";

export const UI_LANGUAGE_OPTIONS: ReadonlyArray<{
  value: UiLanguage;
  label: string;
  description: string;
}> = [
  {
    value: "en",
    label: "English",
    description: "Use English for Skill Bridge"
  },
  {
    value: "ko",
    label: "한국어",
    description: "Skill Bridge를 한국어로 사용"
  }
] as const;

export function isUiLanguage(value: unknown): value is UiLanguage {
  return typeof value === "string" && UI_LANGUAGES.includes(value as UiLanguage);
}

export function coerceUiLanguage(value: unknown): UiLanguage {
  return isUiLanguage(value) ? value : DEFAULT_UI_LANGUAGE;
}

export function getNextUiLanguage(current: UiLanguage): UiLanguage {
  const currentIndex = UI_LANGUAGES.indexOf(current);
  const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % UI_LANGUAGES.length : 0;
  return UI_LANGUAGES[nextIndex] ?? DEFAULT_UI_LANGUAGE;
}

export function getUiLanguageOption(language: UiLanguage): (typeof UI_LANGUAGE_OPTIONS)[number] {
  return UI_LANGUAGE_OPTIONS.find((option) => option.value === language) ?? UI_LANGUAGE_OPTIONS[0];
}

export function localize(language: UiLanguage, english: string, korean: string): string {
  return language === "ko" ? korean : english;
}
