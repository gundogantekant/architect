// Data caches (primitives need setters — importers cannot reassign let exports)
export let backlog = null;
export let orgCache = {};
export let epicCache = null;
export function setBacklog(v) { backlog = v; }
export function setOrgCache(k, v) { orgCache[k] = v; }
export function resetOrgCache() { orgCache = {}; }
export function setEpicCache(v) { epicCache = v; }

// Loader flags
export let markedLoaded = false;
export let xtermLoaded = false;
export let xtermModules = null;
export function setMarkedLoaded(v) { markedLoaded = v; }
export function setXtermLoaded(v) { xtermLoaded = v; }
export function setXtermModules(v) { xtermModules = v; }

// Live session collections (const refs — callers mutate in place)
export const activeDispatches = [];
export const activeTerminals = [];
export const activeCliSessions = [];
export const sessionPanels = new Map();
export const sessionCollapseState = new Map();

// Interval handles
export let sessionsSidebarInterval = null;
export let agentsTileInterval = null;
export let agentsFullRefreshInterval = null;
export let settingsRefreshTimer = null;
export let syncPollInterval = null;
export function setSessionsSidebarInterval(v) { sessionsSidebarInterval = v; }
export function setAgentsTileInterval(v) { agentsTileInterval = v; }
export function setAgentsFullRefreshInterval(v) { agentsFullRefreshInterval = v; }
export function setSettingsRefreshTimer(v) { settingsRefreshTimer = v; }
export function setSyncPollInterval(v) { syncPollInterval = v; }

// Focus popup
export let activeFocusPopup = null;
export function setActiveFocusPopup(v) { activeFocusPopup = v; }

// Window hooks — single declaration point for all app-set window properties
window._termSessions = window._termSessions || new Map();
window._prefs = { default_permission_mode: 'acceptEdits', default_skip_permissions: 'false' };
export function setPrefs(v) { window._prefs = v; }
export function getPrefs() { return window._prefs; }
