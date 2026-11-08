import { type FailureCode } from '../types'

export type StartupConflict = {
  pid: number
  port?: number
  url?: string
  cwd?: string
}

export type StartupFailure = {
  code: Exclude<FailureCode, 'not-responding'>
  message: string
  recovery: string
}

function cleanCapturedValue(value?: string) {
  return value?.trim().replace(/^['"]|['"]$/g, '').replace(/[.,;]$/, '')
}

export function detectStartupConflict(output: string): StartupConflict | null {
  if (!/(?:another|existing).{0,80}(?:server|service|instance|process).{0,80}already running|already-running (?:server|service|instance)|server is already running/i.test(output)) {
    return null
  }

  const pidMatch =
    output.match(/(?:^|\n)\s*[-*]?\s*PID\s*:\s*(\d+)/im) ??
    output.match(/\bPID\s*[#:]?\s*(\d+)\b/i) ??
    output.match(/\bkill\s+(\d+)\b/i)
  const pid = Number(pidMatch?.[1])
  if (!Number.isInteger(pid) || pid <= 1) return null

  const url = cleanCapturedValue(
    output.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::\d+)?[^\s]*/i)?.[0]
  )
  const urlPort = url?.match(/:(\d+)(?:\/|$)/)?.[1]
  const labelledPort = output.match(/\bport\s*[:#]?\s*(\d{2,5})\b/i)?.[1]
  const portValue = Number(urlPort ?? labelledPort)
  const port = Number.isInteger(portValue) && portValue >= 1 && portValue <= 65535 ? portValue : undefined
  const cwd = cleanCapturedValue(
    output.match(/(?:^|\n)\s*[-*]?\s*(?:Dir|Directory|cwd)\s*:\s*([^\r\n]+)/im)?.[1]
  )

  return { pid, port, url, cwd }
}

export function classifyStartupFailure(output: string, fallback: string, port?: number): StartupFailure {
  if (/cannot find module[^\n]*(?:dist|build|out)[/\\]/i.test(output) || /module_not_found[^\n]*(?:dist|build|out)[/\\]/i.test(output)) {
    return {
      code: 'missing-build',
      message: 'The service startup target is missing.',
      recovery: 'Run the project build or choose a development script that does not depend on compiled output.'
    }
  }
  const conflict = detectStartupConflict(output)
  if (conflict) {
    const location = conflict.port ? ' on port ' + conflict.port : ''
    return {
      code: 'existing-instance',
      message: 'Another instance of this service is already running' + location + ' (PID ' + conflict.pid + ').',
      recovery: 'Unplug the existing instance in Multiprise, then retry.'
    }
  }
  if (/EADDRINUSE|address already in use/i.test(output)) {
    return {
      code: 'port-in-use',
      message: 'Port ' + (port ?? 'requested') + ' became unavailable during startup.',
      recovery: 'Launch again to allocate another free port.'
    }
  }
  const runtime = output.match(/(?:command not found|not recognized)[^\n]*|Required runtime "([^"]+)" was not found/i)?.[1]
  if (runtime || /command not found|not recognized as an internal or external command/i.test(output)) {
    return {
      code: 'runtime-missing',
      message: runtime ? 'Required runtime "' + runtime + '" was not found.' : 'A required runtime was not found.',
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
  // Multiprise's own environment errors: a template naming an unknown service, an unreadable secret.
  if (/refers to "[^"]+", which is not a service|needs the port of .+ which has not been assigned|The secret \w+ could not be read/.test(output)) {
    return {
      code: 'environment-missing',
      message: output.split('\n')[0],
      recovery: 'Fix it in the service\'s environment and retry.'
    }
  }
  // Variable names are upper case; "env" alone would also match ".env.example" and friends.
  const envMention = /(?:environment variable|env(?:ironment)?\b)[^\n]*?(?:required|missing|not set)/i.test(output)
  const envName = envMention
    ? output.match(/(?:environment variable|env(?:ironment)?\b)[^\n]*?\b([A-Z][A-Z0-9_]{2,})\b[^\n]*(?:required|missing|not set)/i)?.[1]
    : undefined
  const namedVariable = envName && /^[A-Z][A-Z0-9_]+$/.test(envName) ? envName : undefined
  if (namedVariable || /environment validation failed|missing environment/i.test(output)) {
    return {
      code: 'environment-missing',
      message: namedVariable ? 'Required environment variable ' + namedVariable + ' is missing.' : 'Required environment configuration is missing.',
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
  const unhealthyStatus = output.match(/HTTP readiness failed[^\n]*HTTP\s+(5\d\d)/i)?.[1]
  if (unhealthyStatus) {
    return {
      code: 'unhealthy-response',
      message: 'The service kept returning HTTP ' + unhealthyStatus + ' on port ' + (port ?? 'its assigned port') + '.',
      recovery: 'Check the selected runtime and final startup logs. Multiprise will wait for a non-5xx response before marking it ready.'
    }
  }
  if (/timed out|readiness timeout/i.test(output)) {
    return {
      code: 'timeout',
      message: 'The service did not listen on port ' + (port ?? 'its assigned port') + ' before the startup timeout.',
      recovery: 'Check the final logs, increase the startup timeout, or confirm the service honors the assigned port.'
    }
  }
  return {
    code: 'early-exit',
    message: fallback,
    recovery: 'Review the final service logs and retry after correcting the startup error.'
  }
}

// Errors raised before the service's process runs (preparation, environment, runtime lookup).
export function launchFailureCode(message: string): StartupFailure['code'] {
  const { code } = classifyStartupFailure(message, message)
  return code === 'early-exit' ? 'launch-error' : code
}

export function failureMessage(failure: StartupFailure) {
  return failure.message + ' ' + failure.recovery
}
