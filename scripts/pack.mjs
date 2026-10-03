import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Pack through pnpm so workspace dependency ranges become publishable semver ranges. */
export function packPackage(directory, destination) {
  const cwd = join(root, 'packages', directory);
  const source = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  execFileSync('pnpm', ['pack', '--pack-destination', destination], { cwd, stdio: 'pipe' });
  const filename = `${source.name.replace('@', '').replace('/', '-')}-${source.version}.tgz`;
  const path = join(destination, filename);
  const manifest = JSON.parse(
    execFileSync('tar', ['-xOf', path, 'package/package.json'], { encoding: 'utf8' }),
  );
  const files = execFileSync('tar', ['-tzf', path], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((file) => file.replace(/^package\//, ''));
  return { filename, path, manifest, files };
}
