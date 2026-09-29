import path from 'node:path'
import { type NextFunction, type Request, type RequestHandler, type Response } from 'express'

// Thrown by request handlers and helpers; the error middleware sends its status and message.
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

// Express 4 does not forward rejected promises to the error handler.
export const handle = (fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }

export const cleanPath = (value: string) => value.replace(/\\/g, '/')

export const isValidPort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535

export const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : []

export function isSameOrInside(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
