import en from "./en.json";

/**
 * The English catalogue: the fallback for every other language. Server code, the Node build and tests
 * get the real file. The Workers browser build swaps this module for `english-client.ts`
 * (`vite.config.ts`), so English is not part of the startup script.
 */
export default en;
