#!/usr/bin/env node
/**
 * CI linter: fails if any source file under `src/` contains literal
 * key material (Anthropic, OpenAI, Google/Gemini shapes).
 *
 * This is belt-and-braces for the §14.3 invariant of
 * `LLM_CLIENT.md`: "adapters NEVER emit key material in errors or
 * logs". The adapters already construct log messages from taxonomy
 * objects — no path should let a raw key string end up in a
 * template literal or error message. This script proves it at
 * repo time; the runtime guard is in `pino` redaction hooks in the
 * hosting app.
 *
 * Patterns checked (examples of REAL key shapes — this script would
 * reject them if seen in prod code):
 *
 *  - Anthropic: `sk-ant-` + 40+ URL-safe chars
 *  - OpenAI:    `sk-` + 40+ alphanumeric (NOT sk-ant-; OpenAI keys
 *               are shorter historically but current prod is 48+ chars)
 *  - Google:    `AIza` + 35 URL-safe chars (total ~39)
 *
 * Test fixtures use obvious stubs like `'sk-user'`, `'sk-pool'`,
 * `'sk-bad'`, `'fake-key'` — these DO NOT match the length + format
 * gates, so they pass. If a real key ever slips into a fixture (bad
 * paste), this script catches it.
 *
 * Usage: `pnpm exec tsx scripts/check-no-key-in-logs.ts` or invoked
 * via the `check-keys` npm script wired in `package.json`.
 *
 * Exit codes:
 *   0 — clean
 *   1 — matches found (script prints file:line for each)
 *   2 — script failure (IO error, etc.)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(process.cwd(), 'src');

/** Regex patterns for real-shape key material. */
const KEY_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] =
  [
    {
      name: 'anthropic',
      // sk-ant- followed by 40+ URL-safe chars (actual prod is ~95).
      re: /\bsk-ant-[A-Za-z0-9_-]{40,}\b/g,
    },
    {
      name: 'openai',
      // sk- followed by 40+ alphanumerics, NOT preceded by `ant-`.
      // Modern OpenAI keys start with `sk-` or `sk-proj-` + ~48 chars.
      re: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{40,}\b/g,
    },
    {
      name: 'google',
      // AIza + exactly 35 URL-safe chars (total 39).
      re: /\bAIza[A-Za-z0-9_-]{35}\b/g,
    },
  ];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      out.push(...walk(p));
    } else if (p.endsWith('.ts') || p.endsWith('.tsx')) {
      out.push(p);
    }
  }
  return out;
}

function scan(): number {
  let matches = 0;
  const files = walk(ROOT);
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');
    for (const { name, re } of KEY_PATTERNS) {
      // Global regex — reset lastIndex between files.
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        // Count lines up to the match index.
        const upto = content.slice(0, m.index);
        const line = upto.split('\n').length;
        const rel = relative(process.cwd(), file);
        const excerpt = lines[line - 1]?.trim() ?? '';
        process.stderr.write(
          `  ${rel}:${String(line)} — ${name} key shape detected\n`,
        );
        process.stderr.write(`    ${excerpt}\n`);
        matches += 1;
      }
    }
  }
  return matches;
}

try {
  const matches = scan();
  if (matches > 0) {
    process.stderr.write(
      `\n[check-no-key-in-logs] FAIL: ${String(matches)} match(es) found\n`,
    );
    process.exit(1);
  }
  process.stdout.write('[check-no-key-in-logs] OK — no key material in src/\n');
  process.exit(0);
} catch (e) {
  process.stderr.write(`[check-no-key-in-logs] ERROR: ${String(e)}\n`);
  process.exit(2);
}
