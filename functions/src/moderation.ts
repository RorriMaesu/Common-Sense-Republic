/**
 * Lightweight, heuristic moderation for assistant replies.
 * No external API calls (must work in emulator & tests).
 * Flags (non-exhaustive, additive):
 *  - pii_email: email address detected
 *  - pii_phone: phone-like number detected
 *  - disallowed_term: placeholder forbidden vocabulary detected
 *  - length_excess: extremely long reply trimmed (should already be clamped earlier)
 *
 * If a disallowed term is detected we block the original text and replace with a generic safe notice.
 */
export interface ModerationResult {
  original: string;
  sanitized: string;
  flags: string[];
  blocked: boolean;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
// Simple phone: sequences of 10+ digits optionally separated by spaces, dashes, or parentheses.
const PHONE_RE = /(?:(?:\+?\d{1,3}[\s-]?)?(?:\(\d{3}\)|\d{3})[\s-]?\d{3}[\s-]?\d{4})/;
// Placeholder disallowed vocabulary list (non-hate, neutral token to avoid policy violations). Extend in future via config/Firestore.
const DISALLOWED_TERMS = ['forbiddenterm'];

export function moderateAssistantReply(text: string, customDisallowedTerms?: string[]): ModerationResult {
  const flags: string[] = [];
  if (EMAIL_RE.test(text)) flags.push('pii_email');
  if (PHONE_RE.test(text)) flags.push('pii_phone');
  const lowered = text.toLowerCase();
  let blocked = false;
  const terms = customDisallowedTerms || DISALLOWED_TERMS;
  for (const term of terms) {
    if (lowered.includes(term.toLowerCase())) { flags.push('disallowed_term'); blocked = true; break; }
  }
  // Length sentinel (should already be truncated earlier at ~1800 chars)
  if (text.length > 5000) flags.push('length_excess');
  let sanitized = text;
  if (blocked) sanitized = 'Content removed due to policy guidelines.';
  return { original: text, sanitized, flags, blocked };
}
