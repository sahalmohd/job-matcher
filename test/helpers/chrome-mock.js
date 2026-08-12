'use strict';

/**
 * Minimal in-memory chrome.* mock, enough to load background.js and exercise
 * the scan state machine and alarm reconciliation without a browser.
 */
function createChromeMock({ localData = {}, sessionData = {} } = {}) {
  const listeners = {
    message: [],
    alarm: [],
    tabRemoved: [],
    startup: [],
    installed: [],
    notificationClicked: [],
    notificationClosed: [],
  };

  const areaFrom = (store) => ({
    get(keys, cb) {
      let result = {};
      if (keys == null) result = { ...store };
      else if (typeof keys === 'string') result = keys in store ? { [keys]: store[keys] } : {};
      else if (Array.isArray(keys)) {
        for (const k of keys) if (k in store) result[k] = store[k];
      }
      // chrome's real API accepts a callback and also returns a promise.
      if (cb) { cb(result); return; }
      return Promise.resolve(result);
    },
    set(items, cb) {
      Object.assign(store, items);
      if (cb) { cb(); return; }
      return Promise.resolve();
    },
    remove(keys, cb) {
      for (const k of [].concat(keys)) delete store[k];
      if (cb) { cb(); return; }
      return Promise.resolve();
    },
    _store: store,
  });

  const alarms = new Map();
  const tabs = new Map();
  let nextTabId = 1;

  const chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      sendMessage: () => {},
    },
    storage: {
      local: areaFrom(localData),
      session: areaFrom(sessionData),
    },
    alarms: {
      async create(name, info) { alarms.set(name, { name, ...info }); },
      async clear(name) { return alarms.delete(name); },
      async getAll() { return [...alarms.values()]; },
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
      _alarms: alarms,
    },
    tabs: {
      async create({ url }) {
        const tab = { id: nextTabId++, url };
        tabs.set(tab.id, tab);
        return tab;
      },
      async update(tabId, { url }) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab ${tabId}`);
        tab.url = url;
        return tab;
      },
      async remove(tabId) {
        if (!tabs.has(tabId)) throw new Error(`No tab ${tabId}`);
        tabs.delete(tabId);
      },
      onRemoved: { addListener: (fn) => listeners.tabRemoved.push(fn) },
      _tabs: tabs,
    },
    notifications: {
      create: () => {},
      onClicked: { addListener: (fn) => listeners.notificationClicked.push(fn) },
      onClosed: { addListener: (fn) => listeners.notificationClosed.push(fn) },
    },
    action: { openPopup: () => {} },
  };

  return { chrome, listeners, alarms, tabs };
}

module.exports = { createChromeMock };
