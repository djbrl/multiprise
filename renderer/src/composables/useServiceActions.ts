import { computed, nextTick, reactive, ref } from 'vue'
import { type FailureAction } from '../components/ServiceFailure.vue'
import { apiFetch, errorMessage, jsonBody, openExternal, throwResponseError } from '../lib/api'
import { isDockerService, parsePort, serviceReady, serviceRole, serviceStarting } from '../lib/services'
import { type Group, type ProcessInstance, type ProjectView } from '../types'
import { useLogs } from './useLogs'
import { useNavigation } from './useNavigation'
import { type ManualPortTarget, useOverlays } from './useOverlays'
import { usePorts } from './usePorts'
import { pruneRecord, useProjects } from './useProjects'
import { useSettings } from './useSettings'

// Starting, stopping and launching services, and the per-service state around it:
// the editable command and port, busy flags, errors and the processes holding its port.

const { projects, error, folderGroups, loadProjects, onProjectsLoaded, projectById } = useProjects()
const { selectedGroup, selectedGroupKey, activeSection } = useNavigation()
const { settings } = useSettings()
const { fetchLogs, refreshSelectedLogs } = useLogs()
const { fetchUsedPorts } = usePorts()
const { configServiceId, manualPortTarget } = useOverlays()

type GroupAction = 'launch' | 'stop' | 'delete'

const actionState = reactive<Record<string, { command: string; port: string }>>({})
const actionCommandDirty = reactive<Record<string, boolean>>({})
const actionDetailsOpen = reactive<Record<string, boolean>>({})
const actionErrors = reactive<Record<string, string>>({})
const vscodeErrors = reactive<Record<string, string>>({})
const actionLoading = reactive<Record<string, boolean>>({})
const groupActionLoading = reactive<Record<string, GroupAction | null>>({})
const processInstances = reactive<Record<string, ProcessInstance[]>>({})
// The fixes offered next to a failed service's error.
const failureActionBusy = reactive<Record<string, FailureAction | null>>({})
const copiedServiceUrlId = ref<string | null>(null)
const instancesLoading = ref(false)
const manualPortInputs = reactive<Record<string, string>>({})
const manualPortError = ref('')
// A launch in progress can be cancelled: its remaining services are skipped and the
// ones it already started (or is starting) are stopped.
const groupLaunchCancelled = reactive<Record<string, boolean>>({})
const groupLaunchStarted = new Map<string, Set<string>>()
const errorTimers: Record<string, number> = {}
let copiedServiceUrlTimer: number | undefined

onProjectsLoaded((ids, groups) => {
  const groupKeys = new Set(groups.map((group) => group.key))
  pruneRecord(groupActionLoading, (key) => groupKeys.has(key))
  for (const record of [actionState, actionCommandDirty, actionDetailsOpen, actionErrors, vscodeErrors, processInstances, failureActionBusy]) {
    pruneRecord(record, (id) => ids.has(id))
  }
  // Keys are "action:id" or "action:id:extra".
  pruneRecord(actionLoading, (key) => ids.has(key.split(':')[1] ?? ''))
  syncActionDefaults()
})

function actionFor(item: ProjectView) {
  const id = item.project.id
  if (!actionState[id]) {
    actionState[id] = {
      command: item.project.command ?? '',
      port: item.project.port ? String(item.project.port) : ''
    }
  }
  return actionState[id]
}

// Commands follow the saved ones unless the user is editing the field.
function syncActionDefaults() {
  projects.value.forEach((item) => {
    const state = actionFor(item)
    if (!actionCommandDirty[item.project.id]) {
      state.command = item.project.command ?? ''
    }
  })
}

const actionKey = (action: string, id: string, extra?: string | number) =>
  extra === undefined ? `${action}:${id}` : `${action}:${id}:${extra}`

function isActionLoading(action: string, id: string, extra?: string | number) {
  return !!actionLoading[actionKey(action, id, extra)]
}

function setActionLoading(action: string, id: string, value: boolean, extra?: string | number) {
  actionLoading[actionKey(action, id, extra)] = value
}

function toggleActionDetails(service: ProjectView) {
  actionDetailsOpen[service.project.id] = !actionDetailsOpen[service.project.id]
}

// Errors next to a service fade after a few seconds.
function showTransientError(record: Record<string, string>, prefix: string, id: string, message: string) {
  if (!message) return
  const timer = `${prefix}:${id}`
  record[id] = message
  if (errorTimers[timer]) window.clearTimeout(errorTimers[timer])
  errorTimers[timer] = window.setTimeout(() => {
    delete record[id]
    delete errorTimers[timer]
  }, 4500)
}

const setActionError = (id: string, message: string) => showTransientError(actionErrors, 'action', id, message)
const setVSCodeError = (id: string, message: string) => showTransientError(vscodeErrors, 'vscode', id, message)

// The port typed in the service card, if any.
function servicePort(service: ProjectView) {
  const state = actionFor(service)
  return state.port.trim() === '' ? undefined : parsePort(state.port)
}

function effectivePort(item: ProjectView) {
  if (item.project.port) return item.project.port
  return parsePort(actionFor(item).port) ?? null
}

function projectUrl(item: ProjectView) {
  const port = effectivePort(item)
  return port ? `http://localhost:${port}` : ''
}

function servicePid(service: ProjectView) {
  return service.status.pid ?? (processInstances[service.project.id] ?? []).find((instance) => instance.pid)?.pid ?? null
}

// The port a sibling service should be wired to: the one it is actually using when
// running; otherwise the typed port only matters in manual mode.
function linkedServicePort(item: ProjectView) {
  if (item.status.running && item.project.port) return item.project.port
  if (settings.auto_port) return item.project.port ?? undefined
  return servicePort(item) ?? item.project.port ?? undefined
}

function buildEnvForService(service: ProjectView) {
  const group = folderGroups.value.find((entry) => entry.items.some((item) => item.project.id === service.project.id))
  if (!group) return {}
  const backendService = group.items.find((item) => serviceRole(item) === 'backend')
  const frontendService = group.items.find((item) => serviceRole(item) === 'frontend')
  const backendPort = backendService ? linkedServicePort(backendService) : undefined
  const frontendPort = frontendService ? linkedServicePort(frontendService) : undefined
  const env: Record<string, string> = {}
  if (backendPort) env.BACKEND_PORT = String(backendPort)
  if (frontendPort) env.FRONTEND_PORT = String(frontendPort)
  return env
}

async function openProjectUrl(item: ProjectView) {
  const url = projectUrl(item)
  if (!url) return
  try {
    await openExternal(url)
  } catch (err) {
    setActionError(item.project.id, errorMessage(err, 'Unable to open link'))
  }
}

async function copyProjectUrl(item: ProjectView) {
  const url = projectUrl(item)
  if (!url) return
  try {
    if (!window.vibe?.copyText) throw new Error('Clipboard integration is unavailable.')
    await window.vibe.copyText(url)
    copiedServiceUrlId.value = item.project.id
    if (copiedServiceUrlTimer) window.clearTimeout(copiedServiceUrlTimer)
    copiedServiceUrlTimer = window.setTimeout(() => {
      copiedServiceUrlId.value = null
      copiedServiceUrlTimer = undefined
    }, 1600)
  } catch (err) {
    setActionError(item.project.id, 'Unable to copy link')
  }
}

// Opens the project in VS Code, or in Finder when VS Code is not available.
async function openProjectInEditorOrFinder(group: Group<ProjectView>) {
  const target = group.items[0]
  if (!target) return
  const open = (where: 'vscode' | 'finder') => apiFetch(`/api/projects/${target.project.id}/open`, jsonBody('POST', { target: where }))
  try {
    if ((await open('vscode')).ok) return
  } catch (err) {
    // Fall through to Finder.
  }
  try {
    const response = await open('finder')
    if (!response.ok) await throwResponseError(response, 'Unable to open folder')
  } catch (err) {
    const message = errorMessage(err, 'Unable to open folder')
    error.value = message
    setVSCodeError(target.project.id, message)
  }
}

async function persistServiceCommand(service: ProjectView) {
  const id = service.project.id
  const command = actionFor(service).command.trim()
  if (!command || command === (service.project.command ?? '')) {
    actionCommandDirty[id] = false
    return
  }
  try {
    const response = await apiFetch(`/api/projects/${id}`, jsonBody('PATCH', { command, command_source: 'user' }))
    if (!response.ok) await throwResponseError(response, 'Failed to save command')
    actionCommandDirty[id] = false
    await loadProjects()
  } catch (err) {
    setActionError(id, errorMessage(err, 'Failed to save command'))
  }
}

async function resetServiceCommand(service: ProjectView) {
  const id = service.project.id
  try {
    const response = await apiFetch(`/api/projects/${id}`, jsonBody('PATCH', { command: null, command_source: 'auto' }))
    if (!response.ok) await throwResponseError(response, 'Failed to restore automatic command')
    const data = (await response.json()) as ProjectView
    actionCommandDirty[id] = false
    actionFor(service).command = data.project.command ?? ''
    await loadProjects()
  } catch (err) {
    setActionError(id, errorMessage(err, 'Failed to restore automatic command'))
  }
}

async function fetchInstances(service: ProjectView) {
  try {
    const response = await apiFetch(`/api/projects/${service.project.id}/process/instances`)
    if (!response.ok) throw new Error('Process scan failed')
    const data = (await response.json()) as { instances: ProcessInstance[] }
    processInstances[service.project.id] = data.instances
  } catch (err) {
    error.value = errorMessage(err)
  }
}

async function refreshSelectedInstances() {
  if (!selectedGroup.value || instancesLoading.value) return
  instancesLoading.value = true
  try {
    for (const service of selectedGroup.value.items) {
      processInstances[service.project.id] = []
      await fetchInstances(service)
    }
    await loadProjects()
  } finally {
    instancesLoading.value = false
  }
}

async function startProject(service: ProjectView, options: { forceAutoPort?: boolean; port?: number; env?: Record<string, string> } = {}) {
  error.value = ''
  const id = service.project.id
  const port = options.port ?? (options.forceAutoPort || settings.auto_port ? undefined : servicePort(service))
  const env = options.env ?? buildEnvForService(service)
  if (isActionLoading('start', id)) return false
  setActionLoading('start', id, true)
  delete actionErrors[id]
  try {
    const response = await apiFetch(`/api/projects/${id}/start`, jsonBody('POST', {
      command: actionFor(service).command || undefined,
      port,
      env: Object.keys(env).length ? env : undefined,
      role: serviceRole(service),
      force_auto_port: options.forceAutoPort ? true : undefined
    }))
    if (!response.ok) await throwResponseError(response, 'Failed to start project')
    await loadProjects()
    await refreshSelectedLogs()
    await fetchLogs(id)
    await fetchInstances(service)
    await fetchUsedPorts()
    return true
  } catch (err) {
    const message = errorMessage(err, 'Failed to start service')
    // Cancelled from the Cancel button: nothing went wrong.
    if (message === 'Launch cancelled') {
      await loadProjects()
      return false
    }
    error.value = message
    setActionError(id, message)
    await loadProjects()
    await fetchLogs(id)
    await fetchInstances(service)
    await fetchUsedPorts({ silent: true })
    return false
  } finally {
    setActionLoading('start', id, false)
  }
}

async function stopProject(service: ProjectView) {
  error.value = ''
  const id = service.project.id
  if (isActionLoading('stop', id)) return
  setActionLoading('stop', id, true)
  try {
    const response = await apiFetch(`/api/projects/${id}/stop`, { method: 'POST' })
    if (!response.ok) await throwResponseError(response, 'Failed to stop project')
    await loadProjects()
    await refreshSelectedLogs()
    await fetchLogs(id)
    await fetchInstances(service)
    await fetchUsedPorts()
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    setActionLoading('stop', id, false)
  }
}

// Starting as far as the backend knows, or a start request not yet acknowledged; a service
// that is already running is not "starting" while the app refreshes around it.
function isStarting(service: ProjectView) {
  return serviceStarting(service) || (isActionLoading('start', service.project.id) && !service.status.running)
}

async function toggleService(service: ProjectView) {
  if (service.status.running) {
    await stopProject(service)
  } else if (!settings.auto_port && !isDockerService(service)) {
    requestManualPorts({ kind: 'service', serviceId: service.project.id })
  } else {
    await startProject(service)
  }
}

// Start, or Cancel while it is starting.
async function startOrCancel(service: ProjectView) {
  if (isStarting(service)) await stopProject(service)
  else await toggleService(service)
}

async function runFailureAction(service: ProjectView, action: FailureAction) {
  const id = service.project.id
  if (action === 'environment') {
    configServiceId.value = id
    return
  }
  if (action === 'settings') {
    activeSection.value = 'settings'
    return
  }
  failureActionBusy[id] = action
  try {
    if (action === 'install' || action === 'build') {
      const response = await apiFetch(`/api/projects/${id}/prepare`, jsonBody('POST', { step: action }))
      if (!response.ok) await throwResponseError(response, action === 'install' ? 'Could not install dependencies' : 'The build failed')
    }
    if (action === 'restart') await stopProject(service)
    await startProject(service, action === 'retry-new-port' ? { forceAutoPort: true } : {})
  } catch (err) {
    setActionError(id, err instanceof Error ? err.message : String(err))
  } finally {
    failureActionBusy[id] = null
  }
}

async function killInstance(service: ProjectView, pid: number) {
  error.value = ''
  const id = service.project.id
  if (isActionLoading('kill', id, pid)) return false
  setActionLoading('kill', id, true, pid)
  try {
    const response = await apiFetch(`/api/projects/${id}/process/kill`, jsonBody('POST', { pid }))
    if (!response.ok) await throwResponseError(response, 'Failed to unplug process')
    await fetchInstances(service)
    await loadProjects()
    await fetchUsedPorts({ silent: true })
    return true
  } catch (err) {
    const message = errorMessage(err, 'Unable to unplug process')
    error.value = message
    setActionError(id, message)
    return false
  } finally {
    setActionLoading('kill', id, false, pid)
  }
}

function externalInstancesFor(service: ProjectView) {
  return (processInstances[service.project.id] ?? []).filter((instance) => instance.source === 'external')
}

function startupConflictFor(service: ProjectView) {
  return externalInstancesFor(service).find((instance) => instance.reason === 'startup-conflict') ?? null
}

function startupConflictSummary(service: ProjectView) {
  const conflict = startupConflictFor(service)
  if (!conflict) return ''
  return `${conflict.port ? `:${conflict.port}` : 'an unknown port'} · PID ${conflict.pid}`
}

function externalInstanceSummary(service: ProjectView) {
  return externalInstancesFor(service)
    .map((instance) => `${instance.port ? `:${instance.port}` : 'Port ?'} · ${instance.pid ? `PID ${instance.pid}` : 'PID ?'}`)
    .join(' · ')
}

function isResolvingConflict(service: ProjectView) {
  return isActionLoading('resolve-conflict', service.project.id, startupConflictFor(service)?.pid ?? 0)
}

async function startAnotherInstance(service: ProjectView) {
  if (!settings.auto_port) {
    requestManualPorts({ kind: 'service', serviceId: service.project.id })
    return
  }
  await startProject(service, { forceAutoPort: true })
}

async function killExternalInstance(service: ProjectView) {
  const primary = externalInstancesFor(service)[0]
  if (primary?.pid) await killInstance(service, primary.pid)
}

// Another copy of the service already holds its port: stop that one, then start again.
async function resolveStartupConflict(service: ProjectView) {
  const conflict = startupConflictFor(service)
  if (!conflict?.pid || isActionLoading('resolve-conflict', service.project.id, conflict.pid)) return
  setActionLoading('resolve-conflict', service.project.id, true, conflict.pid)
  try {
    if (await killInstance(service, conflict.pid)) await startProject(service)
  } finally {
    setActionLoading('resolve-conflict', service.project.id, false, conflict.pid)
  }
}

// Manual port mode asks for a port before each launch.
const manualPortServices = computed(() => {
  const target = manualPortTarget.value
  if (!target) return []
  if (target.kind === 'service') {
    const service = projectById(target.serviceId)
    return service ? [service] : []
  }
  const group = folderGroups.value.find((item) => item.key === target.groupKey)
  return group?.items.filter((item) => !isDockerService(item) && !item.status.running) ?? []
})

const manualPortsValid = computed(() => {
  const values = manualPortServices.value.map((service) => parsePort(manualPortInputs[service.project.id] ?? ''))
  if (!values.length || values.some((port) => !port || port < 1 || port > 65535)) return false
  return new Set(values).size === values.length
})

function requestManualPorts(target: ManualPortTarget) {
  manualPortError.value = ''
  manualPortTarget.value = target
  nextTick(() => {
    manualPortServices.value.forEach((service) => {
      manualPortInputs[service.project.id] = String(servicePort(service) ?? effectivePort(service) ?? '')
    })
  })
}

function closeManualPortPrompt() {
  manualPortTarget.value = null
  manualPortError.value = ''
}

async function confirmManualPorts() {
  const target = manualPortTarget.value
  if (!manualPortsValid.value || !target) {
    manualPortError.value = 'Enter a unique port between 1 and 65535 for every service.'
    return
  }
  const selectedPorts = Object.fromEntries(
    manualPortServices.value.map((service) => [service.project.id, parsePort(manualPortInputs[service.project.id] ?? '') as number])
  )
  closeManualPortPrompt()
  if (target.kind === 'service') {
    const service = projectById(target.serviceId)
    if (service) await startProject(service, { port: selectedPorts[service.project.id] })
    return
  }
  const group = folderGroups.value.find((item) => item.key === target.groupKey)
  if (group) await launchGroup(group, selectedPorts)
}

// Support services first, then backends, then (once the backends are ready) frontends,
// each told the backend and frontend ports.
async function launchGroup(group: Group<ProjectView>, manualPorts?: Record<string, number>) {
  if (groupActionLoading[group.key]) return
  groupLaunchCancelled[group.key] = false
  groupLaunchStarted.set(group.key, new Set())
  if (!settings.auto_port && !manualPorts) {
    requestManualPorts({ kind: 'group', groupKey: group.key })
    return
  }
  groupActionLoading[group.key] = 'launch'
  try {
    const regularServices = group.items.filter((service) => !isDockerService(service))
    const byRole = (role: string) => regularServices.filter((service) => serviceRole(service) === role)
    const backendServices = byRole('backend')
    const frontendServices = byRole('frontend')
    const supportServices = byRole('service')
    const primaryBackend = backendServices[0]
    const primaryFrontend = frontendServices[0]
    const runningPort = (service?: ProjectView) =>
      service?.status.running ? effectivePort(service) ?? undefined : undefined
    // The backend hands each stopped service its previous port when it is still free, so URLs stay stable.
    const servicesToAllocate = settings.auto_port
      ? [primaryBackend, primaryFrontend].filter((service): service is ProjectView => !!service && !service.status.running)
      : []

    let allocatedPorts: Record<string, number> = {}
    if (servicesToAllocate.length) {
      const response = await apiFetch('/api/ports/allocate', jsonBody('POST', { services: servicesToAllocate.map((service) => service.project.id) }))
      if (!response.ok) await throwResponseError(response, 'Failed to allocate ports')
      allocatedPorts = ((await response.json()) as { ports?: Record<string, number> }).ports ?? {}
    }

    const portFor = (service?: ProjectView) => service
      ? manualPorts?.[service.project.id] ?? runningPort(service) ?? allocatedPorts[service.project.id] ?? servicePort(service)
      : undefined
    const backendPort = portFor(primaryBackend)
    const frontendPort = portFor(primaryFrontend)
    const groupEnv: Record<string, string> = {}
    if (backendPort) groupEnv.BACKEND_PORT = String(backendPort)
    if (frontendPort) groupEnv.FRONTEND_PORT = String(frontendPort)

    const launchStage = async (services: ProjectView[]) => {
      let allReady = true
      for (const service of services) {
        if (groupLaunchCancelled[group.key]) return false
        if (serviceReady(service)) continue
        groupLaunchStarted.get(group.key)?.add(service.project.id)
        const role = serviceRole(service)
        const port = manualPorts?.[service.project.id] ?? (role === 'backend' ? backendPort : role === 'frontend' ? frontendPort : undefined)
        const ready = await startProject(service, { port, env: Object.keys(groupEnv).length ? groupEnv : undefined })
        if (!ready) allReady = false
      }
      return allReady
    }

    await launchStage(supportServices)
    const backendsReady = await launchStage(backendServices)
    if (groupLaunchCancelled[group.key]) {
      // Nothing to report: the user stopped it.
    } else if (backendsReady) {
      await launchStage(frontendServices)
    } else {
      for (const frontend of frontendServices.filter((service) => !service.status.running)) {
        setActionError(frontend.project.id, 'Waiting for the backend to become ready before launching this service.')
      }
    }
    await loadProjects()
    await refreshSelectedLogs()
    await fetchUsedPorts()
  } finally {
    groupActionLoading[group.key] = null
  }
}

async function cancelGroupLaunch(group: Group<ProjectView>) {
  groupLaunchCancelled[group.key] = true
  const started = groupLaunchStarted.get(group.key) ?? new Set<string>()
  const targets = group.items.filter((service) => !isDockerService(service) && (started.has(service.project.id) || isStarting(service)))
  await Promise.all(targets.map((service) => stopProject(service)))
}

async function stopGroup(group: Group<ProjectView>) {
  if (groupActionLoading[group.key]) return
  groupActionLoading[group.key] = 'stop'
  try {
    for (const service of group.items) {
      if (!isDockerService(service) && service.status.running) await stopProject(service)
    }
  } finally {
    groupActionLoading[group.key] = null
  }
}

// The one button every project shows: Launch, Stop, or Cancel while launching.
function groupPrimaryAction(group: Group<ProjectView>, hasRunning: boolean) {
  if (groupActionLoading[group.key] === 'launch') return cancelGroupLaunch(group)
  return hasRunning ? stopGroup(group) : launchGroup(group)
}

async function deleteGroup(group: Group<ProjectView>) {
  if (groupActionLoading[group.key]) return
  const running = group.items.filter((service) => service.status.running).length
  const warning = running ? `\n\n${running} running service${running === 1 ? ' will' : 's will'} be stopped.` : ''
  if (!window.confirm(`Untrack ${group.name}?${warning}`)) return
  error.value = ''
  groupActionLoading[group.key] = 'delete'
  let failed = 0
  try {
    for (const service of group.items) {
      const response = await apiFetch(`/api/projects/${service.project.id}`, { method: 'DELETE' })
      if (!response.ok) failed += 1
    }
  } catch (err) {
    failed += 1
  }
  groupActionLoading[group.key] = null
  if (failed > 0) {
    error.value = `Failed to untrack ${failed} service${failed === 1 ? '' : 's'}.`
  }
  if (selectedGroupKey.value === group.key) {
    selectedGroupKey.value = null
  }
  await loadProjects()
}

function stopActionTimers() {
  Object.values(errorTimers).forEach((timer) => window.clearTimeout(timer))
  if (copiedServiceUrlTimer) window.clearTimeout(copiedServiceUrlTimer)
}

export function useServiceActions() {
  return {
    actionFor,
    actionCommandDirty,
    actionDetailsOpen,
    actionErrors,
    vscodeErrors,
    groupActionLoading,
    groupLaunchCancelled,
    processInstances,
    failureActionBusy,
    copiedServiceUrlId,
    isActionLoading,
    toggleActionDetails,
    effectivePort,
    projectUrl,
    servicePid,
    openProjectUrl,
    copyProjectUrl,
    openProjectInEditorOrFinder,
    persistServiceCommand,
    resetServiceCommand,
    refreshSelectedInstances,
    startProject,
    stopProject,
    isStarting,
    toggleService,
    startOrCancel,
    runFailureAction,
    killInstance,
    externalInstancesFor,
    startupConflictFor,
    startupConflictSummary,
    externalInstanceSummary,
    isResolvingConflict,
    startAnotherInstance,
    killExternalInstance,
    resolveStartupConflict,
    manualPortServices,
    manualPortInputs,
    manualPortError,
    manualPortsValid,
    closeManualPortPrompt,
    confirmManualPorts,
    launchGroup,
    cancelGroupLaunch,
    stopGroup,
    groupPrimaryAction,
    deleteGroup,
    stopActionTimers
  }
}
