import type { WebXDCApp } from './webxdc-app.js'
import { fileReviewerApp } from './apps/file-reviewer-app.js'
import { permissionsApp } from './apps/permissions-app.js'
import { groupSetupApp } from './apps/group-setup-app.js'

export const apps: WebXDCApp[] = [
  fileReviewerApp,
  permissionsApp,
  groupSetupApp,
]
