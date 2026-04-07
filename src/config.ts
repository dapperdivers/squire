import fs from 'fs';
import yaml from 'js-yaml';

export interface EscalationStep {
  model: string;
  threshold: number | null;  // null = terminal model, accept anything
}

export interface SquireConfig {
  server: {
    port: number;
    name: string;
  };
  backend: {
    url: string;
    apiKey?: string;
  };
  validation: {
    enabled: boolean;
    judgeModel: string;
    threshold: number;
    judgePrompt: string;
  };
  escalation: {
    enabled: boolean;
    maxAttempts: number;
    paths: Record<string, EscalationStep[]>;
  };
  routing?: {
    models?: {
      simple: string;
      moderate: string;
      complex: string;
    };
    classifierPrompt?: string;
  };
  filters: {
    validateModels: string[];
    skipIf: {
      questionLengthLessThan: number;
      containsKeywords: string[];
    };
  };
  metrics: {
    enabled: boolean;
    port: number;
    path: string;
  };
  logging: {
    level: string;
    format: string;
    validationLog: {
      enabled: boolean;
      path: string;
    };
  };
}

function expandEnvVars(obj: any): any {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_, key) => {
      const value = process.env[key];
      if (value === undefined) {
        throw new Error(`Environment variable ${key} not set`);
      }
      return value;
    });
  }
  
  if (Array.isArray(obj)) {
    return obj.map(expandEnvVars);
  }
  
  if (obj !== null && typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandEnvVars(value);
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
    './config/squire.yaml',
  ].filter(Boolean) as string[];
  
  for (const path of paths) {
    if (fs.existsSync(path)) {
      const content = fs.readFileSync(path, 'utf-8');
      const parsed = yaml.load(content);
      return expandEnvVars(parsed) as SquireConfig;
    }
  }
  
  throw new Error(`No config file found. Searched: ${paths.join(', ')}`);
}
