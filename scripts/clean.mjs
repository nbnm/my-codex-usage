import {rm} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(repositoryRoot, 'dist');

if (dirname(target) !== repositoryRoot || target !== join(repositoryRoot, 'dist')) {
  throw new Error('Refusing to clean an unexpected path.');
}

await rm(target, {recursive: true, force: true});
