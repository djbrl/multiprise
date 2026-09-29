import { type AppState } from '../state'
import { type Launches } from '../launch'
import { type listListeningPorts } from '../ports'
import { type HostnameController } from '../hostnames'

// What every route module needs from the app instance.
export type ApiContext = {
  state: AppState
  launches: Launches
  // Shared, briefly cached listening-port snapshot for endpoints polled by every window.
  recentListeningPorts: () => ReturnType<typeof listListeningPorts>
  // The *.localhost proxy; absent in apps built without one (tests).
  hostnames?: HostnameController
}
