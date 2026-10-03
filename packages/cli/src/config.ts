import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import type { MicaConfig } from './index.js';
import { normalizeDeclarations, type DatabaseSchema } from '@mica/db/tooling';

export async function loadConfig(
  cwd: string,
): Promise<{ config: MicaConfig; desired: DatabaseSchema }> {
  const configPath = pathToFileURL(resolve(cwd, 'mica.config.ts')).href;
  const { default: config } = await tsImport(configPath, import.meta.url);
  if (config?.__esModule)
    throw new Error(
      'Mica configuration requires an ESM project: set type to module in package.json',
    );
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).some((key) => !['schema', 'database'].includes(key)) ||
    typeof config.schema !== 'string' ||
    !config.schema.trim()
  )
    throw new Error(
      'mica.config.ts must default-export defineConfig({ schema, database: { uri, name } })',
    );
  const database = config.database;
  if (
    !database ||
    typeof database !== 'object' ||
    Object.keys(database).some((key) => !['uri', 'name'].includes(key)) ||
    typeof database.uri !== 'string' ||
    !database.uri.trim() ||
    typeof database.name !== 'string' ||
    !database.name.trim()
  )
    throw new Error('Configuration requires nonempty database.uri and database.name');
  const schemaPath = pathToFileURL(resolve(cwd, config.schema)).href;
  const { default: collections } = await tsImport(schemaPath, configPath);
  return { config, desired: normalizeDeclarations(collections) };
}
