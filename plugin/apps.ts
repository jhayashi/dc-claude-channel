import type { WebXDCApp } from './webxdc-app.js'
import { markdownViewerApp } from './apps/markdown-viewer-app.js'
import { permissionsApp } from './apps/permissions-app.js'

export const apps: WebXDCApp[] = [
  markdownViewerApp,
  permissionsApp,
]
