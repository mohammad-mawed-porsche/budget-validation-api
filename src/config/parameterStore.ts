import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";

import { OPTIONAL_SECURE_PARAMETER_GROUPS, SECURE_PARAMETER_GROUPS, type SecureParameterGroup } from "./secureParameters.js";

const cachedLoads = new Map<SecureParameterGroup, Promise<void>>();

function parameterName(prefix: string, key: string): string {
  return `${prefix.replace(/\/$/, "")}/${key}`;
}

async function load(prefix: string, group: SecureParameterGroup, environment: NodeJS.ProcessEnv): Promise<void> {
  const requiredKeys: readonly string[] = SECURE_PARAMETER_GROUPS[group];
  const optionalKeys: readonly string[] = OPTIONAL_SECURE_PARAMETER_GROUPS[group];
  const keys = [...requiredKeys, ...optionalKeys];
  const names = keys.map((key) => parameterName(prefix, key));
  const response = await new SSMClient({}).send(new GetParametersCommand({
    Names: names,
    WithDecryption: true,
  }));
  const values = new Map(response.Parameters?.map((parameter) => [parameter.Name, parameter.Value]) ?? []);
  const missing: string[] = [];

  for (const key of keys) {
    const name = parameterName(prefix, key);
    const value = values.get(name);
    if (!value) {
      if (requiredKeys.includes(key)) missing.push(name);
      continue;
    }
    environment[key] = value;
  }

  const requiredNames = new Set(requiredKeys.map((key) => parameterName(prefix, key)));
  for (const invalid of response.InvalidParameters ?? []) {
    if (requiredNames.has(invalid) && !missing.includes(invalid)) missing.push(invalid);
  }
  if (missing.length > 0) {
    throw new Error(`Required SSM SecureString parameters are missing: ${missing.join(", ")}`);
  }
}

export function loadSecureParameters(group: SecureParameterGroup = "all", environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const prefix = environment.SSM_PARAMETER_PREFIX;
  if (!prefix) return Promise.resolve();
  const existing = cachedLoads.get(group);
  if (existing) return existing;
  const pending = load(prefix, group, environment).catch((error) => {
    cachedLoads.delete(group);
    throw error;
  });
  cachedLoads.set(group, pending);
  return pending;
}
