import { z } from 'zod';
import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';

const EscalationTierSchema = z.object({
  model: z.string(),
  threshold: z.number().min(0).max(100).nullable(),
});

const EscalationPathSchema = z.array(EscalationTierSchema);

const ConfigSchema = z.object({
  server: z.object({
    port: z.number().default(4001),
    name: z.string().default('squire'),
    realm: z.string().default('roundtable'),
  }),
  
  litellm: z.object({
    endpoint: z.string().url(),
    apiKey: z.string().optional(),
  }),
  
  validation: z.object({
    enabled: z.boolean().default(true),
    judgeModel: z.string().default('anthropic/claude-haiku-4-6'),
    threshold: z.number().min(0).max(100).default(70),
    judgePrompt: z.string(),
  }),
  
  escalation: z.object({
    enabled: z.boolean().default(true),
    maxAttempts: z.number().min(1).max(10).default(3),
    paths: z.record(z.string(), EscalationPathSchema),
  }),
  
  filters: z.object({
    validateModels: z.array(z.string()).optional(),
    skipIf: z.object({
      questionLengthLessThan: z.number().optional(),
      containsKeywords: z.array(z.string()).optional(),
    }).optional(),
  }).optional(),
  
  metrics: z.object({
    enabled: z.boolean().default(true),
    port: z.number().default(9090),
    path: z.string().default('/metrics'),
    labels: z.record(z.string(), z.string()).optional(),
  }),
  
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    format: z.enum(['json', 'pretty']).default('json'),
    validationLog: z.object({
      enabled: z.boolean().default(true),
      path: z.string().default('/var/log/squire/validations.jsonl'),
    }).optional(),
  }),
});

export type SquireConfig = z.infer<typeof ConfigSchema>;
export type EscalationTier = z.infer<typeof EscalationTierSchema>;

function replaceEnvVars(obj: any): any {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_, key) => {
      const [envKey, defaultValue] = key.split(':-');
      return process.env[envKey] || defaultValue || '';
    });
  }
  
  if (Array.isArray(obj)) {
    return obj.map(replaceEnvVars);
  }
  
  if (obj !== null && typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = replaceEnvVars(value);
    }
    return result;
  }
  
  return obj;
}

export function loadConfig(configPath?: string): SquireConfig {
  const paths = [
    configPath,
    process.env.SQUIRE_CONFIG,
    '/etc/squire/squire.yaml',
    path.join(process.cwd(), 'config', 'squire.yaml'),
  ].filter(Boolean);
  
  for (const p of paths) {
    if (p && fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf-8');
      const rawConfig = yaml.load(content);
      const configWithEnv = replaceEnvVars(rawConfig);
      return ConfigSchema.parse(configWithEnv);
    }
  }
  
  throw new Error(`No config file found. Tried: ${paths.join(', ')}`);
}
