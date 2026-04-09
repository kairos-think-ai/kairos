/**
 * Chrome Extension API type declaration.
 *
 * The web app references chrome.runtime.sendMessage() to communicate
 * with the Kairos browser extension (for auth token passing, extension
 * detection, etc.).
 *
 * At runtime, `chrome` only exists when the extension is installed.
 * All call sites already guard with `typeof chrome !== 'undefined'`
 * before accessing chrome.runtime. This declaration provides the type
 * shape so TypeScript knows the API surface.
 *
 * This is the same approach as @types/chrome but scoped to only
 * the APIs we actually use.
 */
interface ChromeRuntime {
  sendMessage: (
    extensionId: string,
    message: any,
    callback?: (response: any) => void,
  ) => void;
  lastError?: { message: string };
}

interface Chrome {
  runtime: ChromeRuntime;
}

declare var chrome: Chrome;
