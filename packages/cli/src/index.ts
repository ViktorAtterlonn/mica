/** Configuration only; importing this entry point does not load schemas or connect. */
export interface MicaConfig {
  schema: string;
  database: { uri: string; name: string };
}

export function defineConfig(config: MicaConfig): MicaConfig {
  return config;
}
