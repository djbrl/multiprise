import { EventEmitter } from 'node:events'
import { type AppEvent } from './types'

export { type AppEvent }

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
