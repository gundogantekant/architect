// Strips ANSI/VT escape sequences from a string.
// Covers CSI (cursor/color), OSC (title/color queries), 2-char ESC, lone ESC, BEL/BS.
// Sequences are processed longest-first to prevent prefix residue.
// \r and \n are NOT stripped — callers that depend on newline detection must call this first.
export function stripAnsi(raw) {
  return raw
    .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '')    // CSI: ESC[ params final-byte
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC: ESC] content ST/BEL
    .replace(/\x1b[\x20-\x7e]/g, '')                   // 2-char ESC sequences
    .replace(/\x1b/g, '')                              // lone ESC
    .replace(/[\x07\x08]/g, '');                       // standalone BEL and BS
}
