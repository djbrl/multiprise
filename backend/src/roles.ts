import path from 'node:path'
import { type Project, type ServiceRole } from './types'

// Services discovered before roles were recorded are classified by their folder names.
export function projectRoleFallback(project: Project): ServiceRole {
  if (project.role) return project.role
  const root = project.root_path ?? project.path
  const segments = path.relative(root, project.path).toLowerCase().split(/[\\/]/)
  if (segments.some((segment) => ['frontend', 'client', 'web', 'ui', 'app'].includes(segment))) return 'frontend'
  if (segments.some((segment) => ['backend', 'server', 'api'].includes(segment))) return 'backend'
  return 'service'
}
