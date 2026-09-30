// The API's types come from the backend, so the two cannot drift apart; the ones below
// only exist in the interface.
export type * from '../../backend/src/types'

// Services grouped by the project folder they belong to.
export type Group<T> = {
  key: string
  name: string
  path: string
  items: T[]
}

// A project folder added before, offered again on the home screen once it is untracked.
export type RecentProject = {
  path: string
  name: string
  last_seen?: string
}

// A service as the environment editor lists it.
export type ServiceOption = { id: string; name: string; project: string }
