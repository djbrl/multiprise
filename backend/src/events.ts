import { EventEmitter } from 'node:events'
import { type LogLine, type ProcessStatus } from './types'

export type AppEvent =
  // `replace` updates the service's last line in place (its repeat counter grew).
  | { type: 'log'; id: string; entry: LogLine; replace: boolean }
  | { type: 'logs-cleared'; id: string }
  | { type: 'status'; id: string; status: ProcessStatus }
  | { type: 'projects' }

const emitter = new EventEmitter()
// One listener per open renderer, event stream and the menu bar.
emitter.setMaxListeners(0)

export function publish(event: AppEvent) {
  emitter.emit('event', event)
}

export function subscribe(listener: (event: AppEvent) => void) {
  emitter.on('event', listener)
  return () => {
    emitter.off('event', listener)
  }
}
