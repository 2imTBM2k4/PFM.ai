import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.includes(':\\')
  ) {
    const parentURL = context.parentURL ? new URL(context.parentURL) : null;
    const url = parentURL ? new URL(specifier, parentURL) : new URL(specifier);
    const filePath = fileURLToPath(url);

    if (existsSync(filePath)) {
      if (statSync(filePath).isDirectory()) {
        const indexFile = filePath + '/index.ts';
        if (existsSync(indexFile)) {
          return nextResolve(pathToFileURL(indexFile).href, context);
        }
      }
    } else {
      if (existsSync(filePath + '.ts')) {
        return nextResolve(pathToFileURL(filePath + '.ts').href, context);
      }
      if (existsSync(filePath + '/index.ts')) {
        return nextResolve(pathToFileURL(filePath + '/index.ts').href, context);
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.json')) {
    const content = await readFile(fileURLToPath(url), 'utf8');
    return {
      format: 'json',
      shortCircuit: true,
      source: content,
    };
  }
  return nextLoad(url, context);
}
