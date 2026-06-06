// Central web configuration helpers
// Allows overriding functions base via NEXT_PUBLIC_FUNCTIONS_BASE for staging / emulator.
// If using emulators, default to the local emulator URL if not explicitly set.
const defaultFunctionsBase = process.env.NEXT_PUBLIC_USE_EMULATORS === 'true' 
  ? 'http://127.0.0.1:5001/wevote-5400a/us-central1'
  : 'https://us-central1-wevote-5400a.cloudfunctions.net';

export const FUNCTIONS_BASE = (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_FUNCTIONS_BASE) || defaultFunctionsBase;
