import type { WebXDCApp } from './webxdc-app.js'
import { fileReviewerApp } from './apps/file-reviewer-app.js'
import { permissionsApp } from './apps/permissions-app.js'
import { agentSetupApp } from './apps/agent-setup-app.js'
import { familiarApp } from './apps/familiar-app.js'
import { teleportApp } from './apps/teleport-app.js'
import { contactsApp } from './apps/contacts-app.js'

export const apps: WebXDCApp[] = [
  fileReviewerApp,
  permissionsApp,
  agentSetupApp,
  familiarApp,
  teleportApp,
  contactsApp,
]
