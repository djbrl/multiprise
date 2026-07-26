export type StartupFailure = {
  code: 'missing-build' | 'port-in-use' | 'runtime-missing' | 'dependencies-missing' | 'environment-missing' | 'version-mismatch' | 'timeout' | 'early-exit'
  message: string
  recovery: string
}

export function classifyStartupFailure(output: string, fallback: string, port?: number): StartupFailure {
  if (/cannot find module[^\n]*(?:dist|build|out)[/\\]/i.test(output) || /module_not_found[^\n]*(?:dist|build|out)[/\\]/i.test(output)) {
    return {
      code: 'missing-build',
      message: 'The service startup target is missing.',
      recovery: 'Run the project build or choose a development script that does not depend on compiled output.'
    }
  }
  if (/EADDRINUSE|address already in use/i.test(output)) {
    return {
      code: 'port-in-use',
      message: `Port ${port ?? 'requested'} became unavailable during startup.`,
      recovery: 'Launch again to allocate another free port.'
    }
  }
  const runtime = output.match(/(?:command not found|not recognized)[^\n]*|Required runtime "([^"]+)" was not found/i)?.[1]
  if (runtime || /command not found|not recognized as an internal or external command/i.test(output)) {
    return {
      code: 'runtime-missing',
      message: runtime ? `Required runtime "${runtime}" was not found.` : 'A required runtime was not found.',
      recovery: 'Install the runtime and ensure it is available in your interactive login shell PATH.'
    }
  }
  if (/cannot find (?:package|module)|module not found|ERR_MODULE_NOT_FOUND/i.test(output) && /node_modules|package/i.test(output)) {
    return {
      code: 'dependencies-missing',
      message: 'Project dependencies are missing.',
      recovery: 'Install dependencies at the workspace root and retry.'
    }
  }
  const envName = output.match(/(?:environment variable|env(?:ironment)?)[^\n]*?([A-Z][A-Z0-9_]{2,})[^\n]*(?:required|missing|not set)/i)?.[1]
  if (envName || /environment validation failed|missing environment/i.test(output)) {
    return {
      code: 'environment-missing',
      message: envName ? `Required environment variable ${envName} is missing.` : 'Required environment configuration is missing.',
      recovery: 'Add the missing value to the project environment and retry.'
    }
  }
  if (/unsupported (?:node|python) version|engine ["']?(?:node|python)|requires (?:node|python)/i.test(output)) {
    return {
      code: 'version-mismatch',
      message: 'The installed runtime version is not supported by this project.',
      recovery: 'Use the version requested by the project engine or version-manager file.'
    }
  }
  if (/timed out|readiness timeout/i.test(output)) {
    return {
      code: 'timeout',
      message: `The service did not listen on port ${port ?? 'its assigned port'} before the startup timeout.`,
      recovery: 'Check the final logs, increase the startup timeout, or confirm the service honors the assigned port.'
    }
  }
  return {
    code: 'early-exit',
    message: fallback,
    recovery: 'Review the final service logs and retry after correcting the startup error.'
  }
}

export function failureMessage(failure: StartupFailure) {
  return `${failure.message} ${failure.recovery}`
}
