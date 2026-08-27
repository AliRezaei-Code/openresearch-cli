import { useSyncExternalStore } from "react";

/**
 * Interface language support for the dashboard.
 *
 * Locales are additive: add a member to `Locale` plus a matching translation
 * table, and the settings picker and `dir` handling pick it up. `en` is the
 * source of truth for message keys; the `fa` table is compile-time checked to
 * define every key, and `t()` falls back to English for anything a future
 * locale omits.
 *
 * Only the application chrome (navigation, settings, common actions) is
 * localized so far; content panels are progressively translated surface by
 * surface as keys are added.
 */

export type Locale = "en" | "fa";

const LOCALE_META: Record<Locale, { label: string; dir: "ltr" | "rtl" }> = {
  en: { label: "English", dir: "ltr" },
  fa: { label: "فارسی", dir: "rtl" },
};

/** Locales offered in the settings picker, in display order. */
export const LOCALES: Locale[] = ["en", "fa"];

const STORAGE_KEY = "orx:locale";

const en = {
  // Rail navigation
  "nav.files": "Files",
  "nav.artifacts": "Artifacts",
  "nav.experiments": "Experiments",
  "nav.customize": "Customize",
  "nav.compute": "Compute",
  "nav.environment": "Environment",
  "nav.git": "Git",
  "nav.settings": "Settings",
  "nav.projects": "Projects",
  "nav.harnesses": "Harnesses",
  "nav.storage": "Storage",
  "nav.instances": "Instances",

  // Session rail
  "sessions.recents": "Recents",
  "sessions.active": "Active",
  "sessions.archived": "Archived",
  "sessions.all": "All sessions",
  "rail.newTask": "Task",
  "rail.hideSidebar": "Hide sidebar",

  // Project rail header
  "rail.project": "Project",
  "rail.allProjects": "All projects",
  "rail.configureRepository": "Configure Repository",
  "rail.createProject": "Create a new project",

  // Projects home
  "projects.title": "Projects",
  "projects.newProject": "New project",
  "projects.column.project": "Project",
  "projects.column.agents": "Agents",
  "projects.column.experiments": "Experiments",
  "projects.column.repository": "Repository",
  "projects.empty": "No projects yet — create one to get started.",
  "projects.created": "Created {time}",
  "projects.arxivId": "arXiv paper ID: {id}",
  "projects.local": "Local",
  "projects.active": "{n} active",
  "projects.idle": "Idle",
  "projects.running": "{n} running",
  "projects.none": "None",
  "projects.agentsTotal": "{n} total agent{s}",
  "projects.experimentsTotal": "{n} total",
  "projects.open": "Open {name}",
  "projects.delete": "Delete {name}",
  "projects.deleteTitle": "Delete project?",
  "projects.deleteBody":
    "Delete {name} from OpenResearch? Its experiments, runs, and chats will be permanently removed.",
  "projects.deleteBodyFolder": "The local folder{linked} kept.",
  "projects.deleteBodyLinked": " and linked GitHub repository are",
  "projects.deleteBodyLocal": " is",
  "projects.cancel": "Cancel",
  "projects.deleting": "Deleting…",

  // Settings
  "settings.title": "Settings",
  "settings.appearance": "Appearance",
  "settings.appearanceSub": "How the interface looks on this device.",
  "settings.theme": "Theme",
  "settings.themeSub": "System follows your operating system's light or dark setting.",
  "settings.themeSystem": "System",
  "settings.themeLight": "Light",
  "settings.themeDark": "Dark",
  "settings.language": "Language",
  "settings.languageSub": "Choose the language of the interface.",
  "settings.lang.en": "English",
  "settings.lang.fa": "فارسی",
  "settings.projectDefaults": "Project defaults",
  "settings.harnesses": "Harnesses",
  "settings.storage": "Storage",
  "settings.updates": "Updates",
  "settings.environment": "Environment",
  "settings.environmentSub":
    "Variables available to runs and the research agent (API keys, tokens).",
  "settings.compute": "Compute",
  "settings.instances": "Instances",
  "settings.git": "Git",
  "settings.loading": "Loading…",
  "settings.refresh": "Refresh",

  // Right panel
  "panel.expand": "Expand panel",
  "panel.restore": "Restore panel",
  "panel.dragResize": "Drag to resize panel",
  "panel.dragRestore": "Drag right to restore panel",
  "panel.close": "Close panel",

  // Update banner
  "updates.banner": "Updated to {version}. Restart to use it.",
  "updates.dismiss": "Dismiss",
} as const;

export type MessageKey = keyof typeof en;

const fa: Record<MessageKey, string> = {
  "nav.files": "فایلها",
  "nav.artifacts": "مصنوعات",
  "nav.experiments": "آزمایش‌ها",
  "nav.customize": "شخصی‌سازی",
  "nav.compute": "محاسبات",
  "nav.environment": "محیط",
  "nav.git": "گیت",
  "nav.settings": "تنظیمات",
  "nav.projects": "پروژه‌ها",
  "nav.harnesses": "هارنس‌ها",
  "nav.storage": "ذخیره‌سازی",
  "nav.instances": "نمونه‌ها",

  "sessions.recents": "اخیر",
  "sessions.active": "فعال",
  "sessions.archived": "بایگانی‌شده",
  "sessions.all": "همهٔ نشست‌ها",
  "rail.newTask": "وظیفه",
  "rail.hideSidebar": "پنهان‌کردن نوار کناری",

  "rail.project": "پروژه",
  "rail.allProjects": "همهٔ پروژه‌ها",
  "rail.configureRepository": "پیکربندی مخزن",
  "rail.createProject": "ایجاد پروژهٔ جدید",

  "projects.title": "پروژه‌ها",
  "projects.newProject": "پروژهٔ جدید",
  "projects.column.project": "پروژه",
  "projects.column.agents": "عامل‌ها",
  "projects.column.experiments": "آزمایش‌ها",
  "projects.column.repository": "مخزن",
  "projects.empty": "هنوز پروژه‌ای نیست — برای شروع، یکی بسازید.",
  "projects.created": "ایجادشده {time}",
  "projects.arxivId": "شناسهٔ مقالهٔ arXiv: {id}",
  "projects.local": "محلی",
  "projects.active": "{n} فعال",
  "projects.idle": "غیرفعال",
  "projects.running": "{n} در حال اجرا",
  "projects.none": "هیچ",
  "projects.agentsTotal": "در مجموع {n} عامل",
  "projects.experimentsTotal": "در مجموع {n}",
  "projects.open": "باز کردن {name}",
  "projects.delete": "حذف {name}",
  "projects.deleteTitle": "پروژه حذف شود؟",
  "projects.deleteBody":
    "{name} از OpenResearch حذف شود؟ آزمایش‌ها، اجراها و گفت‌وگوهای آن برای همیشه پاک می‌شوند.",
  "projects.deleteBodyFolder": "پوشهٔ محلی{linked} نگه داشته می‌شود.",
  "projects.deleteBodyLinked": " و مخزن گیت‌هاب پیوندشده",
  "projects.deleteBodyLocal": "",
  "projects.cancel": "انصراف",
  "projects.deleting": "در حال حذف…",

  "settings.title": "تنظیمات",
  "settings.appearance": "ظاهر",
  "settings.appearanceSub": "نحوهٔ نمایش رابط کاربری در این دستگاه.",
  "settings.theme": "پوسته",
  "settings.themeSub": "گزینهٔ «سیستم» از تنظیمات روشن یا تاریک سیستم‌عامل پیروی می‌کند.",
  "settings.themeSystem": "سیستم",
  "settings.themeLight": "روشن",
  "settings.themeDark": "تاریک",
  "settings.language": "زبان",
  "settings.languageSub": "زبان رابط کاربری را انتخاب کنید.",
  "settings.lang.en": "English",
  "settings.lang.fa": "فارسی",
  "settings.projectDefaults": "پیش‌فرض‌های پروژه",
  "settings.harnesses": "هارنس‌ها",
  "settings.storage": "ذخیره‌سازی",
  "settings.updates": "به‌روزرسانی‌ها",
  "settings.environment": "محیط",
  "settings.environmentSub":
    "متغیرهایی که برای اجراها و عامل پژوهش در دسترس‌اند (کلیدهای API، توکن‌ها).",
  "settings.compute": "محاسبات",
  "settings.instances": "نمونه‌ها",
  "settings.git": "گیت",
  "settings.loading": "در حال بارگذاری…",
  "settings.refresh": "تازه‌سازی",

  "panel.expand": "باز کردن پنل",
  "panel.restore": "بازگرداندن پنل",
  "panel.dragResize": "برای تغییر اندازهٔ پنل بکشید",
  "panel.dragRestore": "برای بازگرداندن پنل، آن را به راست بکشید",
  "panel.close": "بستن پنل",

  "updates.banner": "به نسخهٔ {version} به‌روزرسانی شد. برای استفاده از آن، برنامه را دوباره راه‌اندازی کنید.",
  "updates.dismiss": "رد کردن",
};

const MESSAGES: Record<Locale, Record<MessageKey, string>> = { en, fa };

/** BCP-47 tag for `Intl` calls (dates, numbers, collation). */
export function localeTag(locale: Locale): string {
  return locale === "fa" ? "fa-IR" : "en-US";
}

function interpolate(
  template: string,
  vars?: Record<string, string | number>,
): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

function readStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "fa") return stored;
  } catch {
    // localStorage may be unavailable (private mode, tests); fall back to en.
  }
  return "en";
}

let locale: Locale = readStoredLocale();
const listeners = new Set<() => void>();

/** Reflect the locale on <html lang/dir> so the whole document (including RTL
 *  layout for Farsi) flips with the preference. */
function applyLocale(): void {
  if (typeof document === "undefined") return;
  const meta = LOCALE_META[locale];
  document.documentElement.lang = locale;
  document.documentElement.dir = meta.dir;
}

export function setLocalePreference(next: Locale): void {
  locale = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Non-fatal: the in-memory locale still applies for this session.
  }
  applyLocale();
  for (const listener of listeners) listener();
}

// The inline script in index.html sets the initial lang/dir before paint;
// re-assert it here in case that script was blocked.
applyLocale();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Current locale, re-rendering subscribers on change. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, () => locale, () => locale);
}

export interface I18n {
  /** Translate a message key, substituting {name} placeholders. */
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  locale: Locale;
  setLocale: (next: Locale) => void;
  /** Document direction for the active locale ("rtl" for Farsi). */
  dir: "ltr" | "rtl";
}

export function useI18n(): I18n {
  const current = useLocale();
  return {
    t: (key, vars) => translate(current, key, vars),
    locale: current,
    setLocale: setLocalePreference,
    dir: LOCALE_META[current].dir,
  };
}

/** Pure lookup with English fallback; the hook above binds it to the active
 *  locale. Exported for tests and any non-React callers. */
export function translate(
  locale: Locale,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  return interpolate(MESSAGES[locale][key] ?? en[key], vars);
}

/** Message catalog, exported for tests. */
export function messagesFor(locale: Locale): Record<MessageKey, string> {
  return MESSAGES[locale];
}
