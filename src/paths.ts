import { realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

export const DENIED = /(^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.aws|\.ssh|\.git|\.codex|\.agents|node_modules|\.conda|credentials(?:\.[^\\/]*)?|secrets?(?:\.[^\\/]*)?)([\\/]|$)|\.(?:pem|key|p12|pfx)$/i;
export async function safePath(root: string, value: string): Promise<string> {
  if (!value || isAbsolute(value) || DENIED.test(value)) throw new Error('Use a workspace-relative path outside credential and dependency directories.');
  const base = await realpath(root), path = await realpath(resolve(base, value));
  const rel = relative(base, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || DENIED.test(rel)) throw new Error('Path is outside the permitted workspace.');
  return path;
}
