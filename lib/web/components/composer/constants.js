// constants.js - Centralize regex and other constants
export  const CONSTANTS = {
    MIN_PREFIX_LENGTH: 2,
    VALID_CHARS: "[\\w\\+_\\-:]",
    MENTION_PREFIX: "(?:@)",
    EMOJI_PREFIX: "(?::)",
    get MENTION_REGEX() {
      return new RegExp(
        `(?:\\s|^)(${this.MENTION_PREFIX}${this.VALID_CHARS}{${this.MIN_PREFIX_LENGTH},})$`
      );
    },
    get EMOJI_REGEX() {
      return new RegExp(
        `(?:\\s|^)(${this.EMOJI_PREFIX}${this.VALID_CHARS}{${this.MIN_PREFIX_LENGTH},})$`
      );
    }
  };