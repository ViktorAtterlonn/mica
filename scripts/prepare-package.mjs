import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
for (const file of ['LICENSE', 'NOTICE']) copyFileSync(join(root, file), join(process.cwd(), file));
