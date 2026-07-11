/**
 * Help card app shell (#108). Deliberately minimal: the card is static
 * (content injected at build time), informational, and viewable by all —
 * no tools, no status-update handling, no §6 gate (spec §3.5). Try-it
 * uses window.webxdc.sendToChat, which drafts the phrase as the USER's
 * message, so every action still flows through the existing authenticated
 * gates. Opened only via /help (slash-handler → server.ts wiring).
 */
import type { WebXDCApp } from '../webxdc-app.js'

export const helpApp: WebXDCApp = {
  id: 'help',
  tools() { return [] },
  async callTool() { return null },
}
