import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where a top-level project folder ("web", "config") is, however the code is running:
 *   - from src/ (tsx) or dist/ (node): one level up from this file;
 *   - bundled into one file on a serverless host: this file's own location means nothing there,
 *     but the host runs the function from the project root, so the working directory has it.
 * The first candidate that exists wins. If none does, the first is returned so the error a caller
 * raises names a sensible path.
 */
export function projectDir(name: string): string {
  const candidates = [fileURLToPath(new URL(`../${name}/`, import.meta.url)), resolve(process.cwd(), name)];
  return candidates.find((dir) => existsSync(dir)) ?? candidates[0]!;
}
