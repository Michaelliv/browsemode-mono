// Exit codes the CLI uses. Stable contract for scripts.
export const EXIT_SUCCESS = 0;
export const EXIT_ERROR = 1;
export const EXIT_USER_ERROR = 2; // bad flag, missing arg, parse failure
export const EXIT_NOT_FOUND = 3; // browser id / file / endpoint not found
export const EXIT_UNREACHABLE = 4; // CDP probe failed, browser hung
