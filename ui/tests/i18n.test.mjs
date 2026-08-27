import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCALES,
  localeTag,
  messagesFor,
  translate,
} from "../src/i18n.ts";

const EN = messagesFor("en");
const FA = messagesFor("fa");

test("every locale defines exactly the English key set", () => {
  const enKeys = Object.keys(EN).sort();
  for (const locale of LOCALES) {
    assert.deepEqual(Object.keys(messagesFor(locale)).sort(), enKeys);
  }
});

test("Farsi strings are translated, not English echoes", () => {
  assert.equal(FA["nav.settings"], "تنظیمات");
  assert.equal(FA["projects.title"], "پروژه‌ها");
  assert.equal(FA["settings.lang.fa"], "فارسی");
});

test("templates interpolate placeholders in both locales", () => {
  assert.equal(translate("en", "projects.agentsTotal", { n: 1, s: "" }), "1 total agent");
  assert.equal(translate("en", "projects.agentsTotal", { n: 3, s: "s" }), "3 total agents");
  assert.equal(translate("fa", "projects.active", { n: 2 }), "2 فعال");
  assert.equal(translate("fa", "projects.delete", { name: "کاغذ" }), "حذف کاغذ");
});

test("unbound placeholders are left intact", () => {
  assert.equal(translate("en", "projects.created"), "Created {time}");
});

test("Farsi maps to the fa-IR Intl tag, English to en-US", () => {
  assert.equal(localeTag("fa"), "fa-IR");
  assert.equal(localeTag("en"), "en-US");
});
