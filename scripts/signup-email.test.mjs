import assert from "node:assert/strict";
import { test } from "node:test";
import { SIGNUP_EMAIL_DOMAINS, signupEmailAllowed } from "../src/lib/signup-email.ts";

const DOMAINS = [
  "qq.com", "163.com", "126.com", "gmail.com", "outlook.com", "hotmail.com", "icloud.com", "yahoo.com",
];

test("signup email domains are exactly the eight supported providers", () => {
  assert.deepEqual([...SIGNUP_EMAIL_DOMAINS], DOMAINS);
  assert.equal(new Set(SIGNUP_EMAIL_DOMAINS).size, 8);
});

test("signup email accepts every provider, case, surrounding whitespace, and plus tags", () => {
  for (const domain of DOMAINS) {
    for (const email of [
      `reader@${domain}`,
      `ReAdEr@${domain.toUpperCase()}`,
      ` \tReader@${domain.toUpperCase()}\r\n`,
      `reader+books@${domain}`,
      `first.last_123@${domain}`,
    ]) {
      assert.equal(signupEmailAllowed(email), true, JSON.stringify(email));
    }
  }
});

test("signup email rejects malformed addresses even with an allowed domain", () => {
  for (const email of [
    "", " ", "reader", "gmail.com", "@gmail.com", "reader@", "reader@@gmail.com",
    "reader@other@gmail.com", "reader@gmail.com@", "reader name@gmail.com",
    "reader\nname@gmail.com", "reader@ gmail.com", "reader@ gmail.com ",
    "reader@gmail .com", "reader@gmail.com/path", "reader@gmail.com?x=1",
    "reader@gmail.com#tag", "reader@gmail.com:443", "reader<test>@gmail.com",
    "Reader <reader@gmail.com>", '"reader"@gmail.com', "\u8bfb\u8005@gmail.com",
    `${"a".repeat(245)}@gmail.com`,
  ]) {
    assert.equal(signupEmailAllowed(email), false, JSON.stringify(email));
  }
});

test("signup email requires an exact provider domain, not a suffix or lookalike", () => {
  for (const domain of DOMAINS) {
    for (const candidate of [
      `mail.${domain}`, `evil${domain}`, `${domain}.evil.com`, `${domain}.`,
      domain.replace(".com", ".net"), domain.replace(".com", "com"),
      domain.replace(".com", ".co"), domain.replace(".com", ".c\u043em"),
    ]) {
      assert.equal(signupEmailAllowed(`reader@${candidate}`), false, candidate);
    }
  }
  for (const domain of [
    "example.com", "custom.com", "company.com", "protonmail.com", "gamil.com", "gmail.co",
    "gmail.con", "gmail.com.cn", "googlemail.com", "live.com", "yahoo.co.uk", "qq.cn",
    "gma\u0456l.com", "\uff47mail.com", "gmail\uff0ecom", "gm\u0430il.com", "163.c\u03bfm",
    "gmail.com\u200b", "gmail.com\u0000", "gmail.com%00.evil.com",
  ]) {
    assert.equal(signupEmailAllowed(`reader@${domain}`), false, domain);
  }
});
