/** Exact provider domains accepted for new accounts, never a general .com suffix policy. */
export const SIGNUP_EMAIL_DOMAINS = [
  "qq.com", "163.com", "126.com", "gmail.com", "outlook.com", "hotmail.com", "icloud.com", "yahoo.com",
] as const;

const allowed = new Set<string>(SIGNUP_EMAIL_DOMAINS);
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

/** Separate from general account validation: existing accounts may use any supported address. */
export function signupEmailAllowed(value: string): boolean {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) return false;
  return allowed.has(email.slice(email.lastIndexOf("@") + 1));
}
