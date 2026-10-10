/** Recognize TAP and Node's Unicode pretty reporter, including split chunks. */
export function skipDetector() {
  const tails = new Map(); let skipped = false;
  return {
    observe(value, stream = 'stdout') {
      const text = (tails.get(stream) ?? '') + String(value).replace(/\u001b\[[0-9;]*m/g, '');
      if (/\bskipped\s+[1-9]\d*\b|#\s*SKIP\b/.test(text)) skipped = true;
      tails.set(stream, text.slice(-1024));
    },
    hasSkipped() {return skipped;},
  };
}
