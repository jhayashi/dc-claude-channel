import type { WebXDCApp } from './webxdc-app.js'
import { fileReviewerApp } from './apps/file-reviewer-app.js'
import { permissionsApp } from './apps/permissions-app.js'
import { agentSetupApp } from './apps/agent-setup-app.js'
import { slideViewerApp } from './apps/slide-viewer-app.js'

export const apps: WebXDCApp[] = [
  fileReviewerApp,
  permissionsApp,
  agentSetupApp,
  slideViewerApp,
]
