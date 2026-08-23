"use strict";

importScripts("archive-core.js");

const ArchiveCore = self.WebMemoryFerryArchiveCore;

const DB_NAME = "web-memory-ferry-v1";
const DB_VERSION = 2;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("checkpoints")) {
        db.createObjectStore("checkpoints", { keyPath: "roomKey" });
      }
      if (!db.objectStoreNames.contains("snapshots")) {
        const store = db.createObjectStore("snapshots", { keyPath: "snapshotId" });
        store.createIndex("roomKey", "roomKey", { unique: false });
        store.createIndex("completedAt", "completedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains("adapterPlans")) {
        db.createObjectStore("adapterPlans", { keyPath: "profileId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("E-DB-OPEN"));
  });
}

async function transact(storeName, mode, action) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let value;
      try { value = action(store); } catch (error) { reject(error); return; }
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error || new Error("E-DB-TX"));
      transaction.onabort = () => reject(transaction.error || new Error("E-DB-ABORT"));
    });
  } finally {
    db.close();
  }
}

function getRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error || new Error("E-DB-GET"));
  });
}

async function getLatestSnapshot(roomKey) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("snapshots", "readonly");
      const index = tx.objectStore("snapshots").index("roomKey");
      const request = index.getAll(IDBKeyRange.only(roomKey));
      request.onsuccess = () => {
        const values = request.result || [];
        values.sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
        resolve(values[0] || null);
      };
      request.onerror = () => reject(request.error || new Error("E-DB-LATEST"));
    });
  } finally {
    db.close();
  }
}

async function getLatestTopConfirmedEvidence(roomKey) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("snapshots", "readonly");
      const request = tx.objectStore("snapshots").index("roomKey").getAll(IDBKeyRange.only(roomKey));
      request.onsuccess = () => {
        const values = (request.result || []).filter((item) => item.evidence?.topConfirmed);
        values.sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
        const snapshot = values[0];
        resolve(snapshot ? { snapshotId: snapshot.snapshotId, completedAt: snapshot.completedAt, evidence: snapshot.evidence } : null);
      };
      request.onerror = () => reject(request.error || new Error("E-DB-TOP-EVIDENCE"));
    });
  } finally { db.close(); }
}

async function getAllSnapshots() {
  const db = await openDb();
  try {
    const tx = db.transaction("snapshots", "readonly");
    return await getRequest(tx.objectStore("snapshots").getAll()) || [];
  } finally { db.close(); }
}

async function getSnapshot(snapshotId) {
  const db = await openDb();
  try {
    const tx = db.transaction("snapshots", "readonly");
    return await getRequest(tx.objectStore("snapshots").get(snapshotId));
  } finally { db.close(); }
}

async function deleteRoom(roomKey) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(["snapshots", "checkpoints"], "readwrite");
      const snapshots = tx.objectStore("snapshots");
      const request = snapshots.index("roomKey").openKeyCursor(IDBKeyRange.only(roomKey));
      let deletedSnapshots = 0;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        snapshots.delete(cursor.primaryKey);
        deletedSnapshots += 1;
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error("E-DB-DELETE-CURSOR"));
      tx.objectStore("checkpoints").delete(roomKey);
      tx.oncomplete = () => resolve({ deletedSnapshots });
      tx.onerror = () => reject(tx.error || new Error("E-DB-DELETE"));
      tx.onabort = () => reject(tx.error || new Error("E-DB-DELETE-ABORT"));
    });
  } finally { db.close(); }
}

function localTodayStartIso() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const run = async () => {
    switch (message?.type) {
      case "checkpoint.put":
        await transact("checkpoints", "readwrite", (store) => store.put(message.value));
        return { ok: true };
      case "checkpoint.get": {
        const db = await openDb();
        try {
          const tx = db.transaction("checkpoints", "readonly");
          return { ok: true, value: await getRequest(tx.objectStore("checkpoints").get(message.roomKey)) };
        } finally { db.close(); }
      }
      case "snapshot.commit":
        await transact("snapshots", "readwrite", (store) => store.add(message.value));
        await transact("checkpoints", "readwrite", (store) => store.delete(message.value.roomKey));
        return { ok: true };
      case "snapshot.latest":
        return { ok: true, value: await getLatestSnapshot(message.roomKey) };
      case "snapshot.latest-top-confirmed":
        return { ok: true, value: await getLatestTopConfirmedEvidence(message.roomKey) };
      case "adapter-plan.put":
        await transact("adapterPlans", "readwrite", (store) => store.put(message.value));
        return { ok: true };
      case "adapter-plan.get": {
        const db = await openDb();
        try {
          const tx = db.transaction("adapterPlans", "readonly");
          return { ok: true, value: await getRequest(tx.objectStore("adapterPlans").get(message.profileId)) };
        } finally { db.close(); }
      }
      case "archive.summary": {
        const snapshots = await getAllSnapshots();
        return { ok: true, value: ArchiveCore.summarizeSnapshots(snapshots, {
          query: String(message.query || "").slice(0, 200),
          todayStartIso: localTodayStartIso(),
        }) };
      }
      case "archive.snapshot.get":
        return { ok: true, value: await getSnapshot(message.snapshotId) };
      case "archive.latest.all":
        return { ok: true, value: ArchiveCore.latestSnapshots(await getAllSnapshots()) };
      case "archive.room.delete": {
        const result = await deleteRoom(message.roomKey);
        return { ok: true, value: result };
      }
      default:
        return { ok: false, error: "E-UNKNOWN-MESSAGE" };
    }
  };
  run().then(sendResponse).catch(() => sendResponse({ ok: false, error: "E-LOCAL-ARCHIVE" }));
  return true;
});
