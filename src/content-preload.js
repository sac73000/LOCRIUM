/**
 * LOCRIUM — Content preload script
 *
 * Runs in every BrowserView (page content) BEFORE any page JavaScript.
 * contextIsolation: true — this isolated world CANNOT patch page prototypes.
 *
 * Anti-fingerprinting injection strategy:
 *   Prototype patching (WebGPU, WebGL, Canvas) is performed by the MAIN PROCESS
 *   via view.webContents.executeJavaScript() at the 'dom-ready' event.
 *   executeJavaScript() runs in the page's main world, so prototype changes
 *   are visible to page code.
 *
 * Known limitation: dom-ready fires after <head> scripts may have already
 *   executed. Very early fingerprinting code in inline <head> scripts may not
 *   be intercepted. This is an inherent limitation of dom-ready injection.
 *
 * Security rules:
 *   - contextIsolation: true — page code has no Node.js access
 *   - nodeIntegration: false
 *   - Nothing is exposed to the page intentionally
 */

'use strict';

// Intentionally empty — see header comment for anti-FP architecture notes.
// Future content scripts (reader mode, safe utilities) can be added here
// via contextBridge.exposeInMainWorld('lcrContent', { ... }).
