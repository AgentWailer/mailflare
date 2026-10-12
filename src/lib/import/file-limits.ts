// Archives can be arbitrarily large; each upload and each parsed message remain bounded.
export const MAX_IMPORT_REQUEST_SIZE = 25 * 1024 * 1024;
export const MAX_IMPORT_MESSAGES = 100;
export const MAX_FILE_MESSAGE_SIZE = 20 * 1024 * 1024;
export const MBOX_READ_CHUNK_SIZE = 2 * 1024 * 1024;
