import type { WebXDCApp } from './webxdc-app.js'
import { fileReviewerApp } from './apps/file-reviewer-app.js'
import { permissionsApp } from './apps/permissions-app.js'
import { familiarApp } from './apps/familiar-app.js'
import { teleportApp } from './apps/teleport-app.js'
import { contactsApp } from './apps/contacts-app.js'
import { createApp } from './apps/create-app.js'
import { agentManageApp } from './apps/agent-manage-app.js'
import { helpApp } from './apps/help-app.js'

export const apps: WebXDCApp[] = [
  fileReviewerApp,
  permissionsApp,
  familiarApp,
  teleportApp,
  contactsApp,
  createApp,
  agentManageApp,
  helpApp,
]
