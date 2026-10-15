/**
 * Circuitech Universal Database & Security Engine
 * Hybrid Architecture:
 * 1. Global Cloud Mode: Supabase (PostgreSQL Cloud Auth) - Multi-Device Global Access.
 * 2. Local Fallback Mode: IndexedDB + Web Crypto PBKDF2-SHA256 (100,000 rounds).
 */

const SecurityDB = (function() {
  'use strict';

  // --- Supabase Cloud Configuration ---
  // You can paste your Supabase Project URL and Anon Key here, or configure them via the UI
  const CLOUD_CONFIG = {
    url: 'https://akdbhjonjholgpxqhfkc.supabase.co',
    anonKey: 'sb_publishable_1bP3zUfaLxj_VqTEwVhMDw_Ekuig1O1'
  };

  const SESSION_KEY = 'circuitech_active_session';
  const CONFIG_STORAGE_KEY = 'circuitech_supabase_config';
  const DB_NAME = 'CircuitechSecureStore';
  const DB_VERSION = 1;
  const STORE_NAME = 'users';
  const PBKDF2_ITERATIONS = 100000;
  const MAX_FAILED_ATTEMPTS = 5;
  const LOCKOUT_MINUTES = 5;

  let supabaseClient = null;
  let dbPromise = null;

  // --- Load Cloud Configuration ---
  function loadCloudConfig() {
    try {
      const saved = localStorage.getItem(CONFIG_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.url && parsed.anonKey) {
          CLOUD_CONFIG.url = parsed.url;
          CLOUD_CONFIG.anonKey = parsed.anonKey;
        }
      }
    } catch (e) {
      console.warn('Error reading cloud database config:', e);
    }

    if (CLOUD_CONFIG.url && CLOUD_CONFIG.anonKey && window.supabase) {
      try {
        supabaseClient = window.supabase.createClient(CLOUD_CONFIG.url, CLOUD_CONFIG.anonKey);
      } catch (err) {
        console.error('Failed to initialize Supabase client:', err);
        supabaseClient = null;
      }
    }
  }

  function setCloudConfig(url, anonKey) {
    CLOUD_CONFIG.url = (url || '').trim();
    CLOUD_CONFIG.anonKey = (anonKey || '').trim();

    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify({
      url: CLOUD_CONFIG.url,
      anonKey: CLOUD_CONFIG.anonKey
    }));

    if (CLOUD_CONFIG.url && CLOUD_CONFIG.anonKey && window.supabase) {
      supabaseClient = window.supabase.createClient(CLOUD_CONFIG.url, CLOUD_CONFIG.anonKey);
      return true;
    } else {
      supabaseClient = null;
      return false;
    }
  }

  function isCloudActive() {
    return Boolean(supabaseClient && CLOUD_CONFIG.url && CLOUD_CONFIG.anonKey);
  }

  function getCloudConfig() {
    return {
      url: CLOUD_CONFIG.url,
      anonKey: CLOUD_CONFIG.anonKey,
      isActive: isCloudActive()
    };
  }

  // --- Local IndexedDB Engine (Fallback) ---
  function openLocalDatabase() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = function(event) {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'email' });
          store.createIndex('name', 'name', { unique: false });
        }
      };

      request.onsuccess = function(event) {
        const db = event.target.result;
        seedAdmin(db);
        resolve(db);
      };

      request.onerror = function(event) {
        reject(event.target.error);
      };
    });

    return dbPromise;
  }

  function bufferToHex(buffer) {
    const bytes = new Uint8Array(buffer);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  }

  function generateSalt() {
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    return bufferToHex(salt);
  }

  async function hashPassword(password, saltHex) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      'PBKDF2',
      false,
      ['deriveBits']
    );

    const saltBytes = new Uint8Array(saltHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));

    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: saltBytes,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256'
      },
      keyMaterial,
      256
    );

    return bufferToHex(derivedBits);
  }

  async function seedAdmin(db) {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get('operator@circuitech.com');

    getReq.onsuccess = async function() {
      if (!getReq.result) {
        const salt = generateSalt();
        const hash = await hashPassword('Circuitech#2026', salt);
        const writeTx = db.transaction(STORE_NAME, 'readwrite');
        writeTx.objectStore(STORE_NAME).add({
          email: 'operator@circuitech.com',
          name: 'Chief Systems Operator',
          role: 'Administrator',
          salt: salt,
          hash: hash,
          failedAttempts: 0,
          lockedUntil: 0,
          createdAt: new Date().toISOString()
        });
      }
    };
  }

  // --- Unified Registration ---
  async function registerUser(name, email, password) {
    const cleanEmail = email.trim().toLowerCase();
    const cleanName = name.trim();

    if (!cleanName || cleanName.length < 2) {
      throw new Error('Full name must be at least 2 characters.');
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      throw new Error('Please enter a valid email address.');
    }
    if (password.length < 8) {
      throw new Error('Password must be at least 8 characters long.');
    }

    // 1. If Supabase Cloud is active, register globally in PostgreSQL
    if (isCloudActive()) {
      const { data, error } = await supabaseClient.auth.signUp({
        email: cleanEmail,
        password: password,
        options: {
          data: {
            name: cleanName,
            role: 'Engineer'
          }
        }
      });

      if (error) {
        throw new Error(error.message);
      }

      // Set verified session
      const sessionUser = (data.user && data.user.user_metadata && data.user.user_metadata.name) || cleanName;
      setSession({
        name: sessionUser,
        email: cleanEmail,
        role: 'Engineer',
        source: 'Supabase Cloud (PostgreSQL)'
      });

      return { success: true, mode: 'cloud', user: { name: cleanName, email: cleanEmail } };
    }

    // 2. Otherwise, use local IndexedDB with PBKDF2-SHA256
    const db = await openLocalDatabase();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      const checkReq = store.get(cleanEmail);
      checkReq.onsuccess = async function() {
        if (checkReq.result) {
          reject(new Error('An account with this email address already exists.'));
          return;
        }

        try {
          const salt = generateSalt();
          const hash = await hashPassword(password, salt);

          const record = {
            name: cleanName,
            email: cleanEmail,
            role: 'Engineer',
            salt: salt,
            hash: hash,
            failedAttempts: 0,
            lockedUntil: 0,
            createdAt: new Date().toISOString()
          };

          const addReq = store.add(record);
          addReq.onsuccess = function() {
            setSession({
              name: record.name,
              email: record.email,
              role: record.role,
              source: 'Local Encrypted DB'
            });
            resolve({ success: true, mode: 'local', user: { name: record.name, email: record.email } });
          };
          addReq.onerror = function() {
            reject(new Error('Failed to create account database entry.'));
          };
        } catch (err) {
          reject(err);
        }
      };

      checkReq.onerror = function() {
        reject(new Error('Database read failure.'));
      };
    });
  }

  // --- Unified Authentication ---
  async function authenticateUser(email, password) {
    const cleanEmail = email.trim().toLowerCase();

    // 1. If Supabase Cloud is active, authenticate globally
    if (isCloudActive()) {
      const { data, error } = await supabaseClient.auth.signInWithPassword({
        email: cleanEmail,
        password: password
      });

      if (error) {
        throw new Error(error.message);
      }

      const userName = (data.user.user_metadata && data.user.user_metadata.name) || cleanEmail.split('@')[0];

      setSession({
        name: userName,
        email: data.user.email,
        role: (data.user.user_metadata && data.user.user_metadata.role) || 'Engineer',
        source: 'Supabase Cloud (PostgreSQL)'
      });

      return { success: true, mode: 'cloud', user: { name: userName, email: data.user.email } };
    }

    // 2. Otherwise, authenticate via local IndexedDB
    const db = await openLocalDatabase();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      const req = store.get(cleanEmail);
      req.onsuccess = async function() {
        const user = req.result;
        if (!user) {
          reject(new Error('Invalid email or password credentials.'));
          return;
        }

        const now = Date.now();
        if (user.lockedUntil && user.lockedUntil > now) {
          const remainingMins = Math.ceil((user.lockedUntil - now) / 60000);
          reject(new Error(`Account temporarily locked for security. Please try again in ${remainingMins} minute(s).`));
          return;
        }

        try {
          const computedHash = await hashPassword(password, user.salt);

          if (computedHash === user.hash) {
            user.failedAttempts = 0;
            user.lockedUntil = 0;
            user.lastLogin = new Date().toISOString();
            store.put(user);

            setSession({
              name: user.name,
              email: user.email,
              role: user.role || 'Operator',
              source: 'Local Encrypted DB'
            });

            resolve({ success: true, mode: 'local', user: { name: user.name, email: user.email } });
          } else {
            user.failedAttempts = (user.failedAttempts || 0) + 1;
            if (user.failedAttempts >= MAX_FAILED_ATTEMPTS) {
              user.lockedUntil = now + (LOCKOUT_MINUTES * 60 * 1000);
              store.put(user);
              reject(new Error(`Account locked due to 5 consecutive failed attempts. Try again in ${LOCKOUT_MINUTES} minutes.`));
            } else {
              store.put(user);
              const remaining = MAX_FAILED_ATTEMPTS - user.failedAttempts;
              reject(new Error(`Invalid credentials. ${remaining} attempt(s) remaining before security lockout.`));
            }
          }
        } catch (err) {
          reject(err);
        }
      };

      req.onerror = function() {
        reject(new Error('Database verification error.'));
      };
    });
  }

  // --- Session Management ---
  function setSession(userData) {
    const sessionObj = {
      ...userData,
      token: crypto.randomUUID ? crypto.randomUUID() : ('tok_' + Math.random().toString(36).substring(2)),
      timestamp: Date.now()
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(sessionObj));
    localStorage.setItem('circuitech_user_cache', JSON.stringify({ name: userData.name, email: userData.email }));
  }

  function getSession() {
    try {
      const data = sessionStorage.getItem(SESSION_KEY);
      if (!data) return null;
      const parsed = JSON.parse(data);
      if (Date.now() - parsed.timestamp > 8 * 3600 * 1000) {
        clearSession();
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  function clearSession() {
    if (supabaseClient) {
      try { supabaseClient.auth.signOut(); } catch (e) { /* ignore */ }
    }
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem('circuitech_user_cache');
  }

  // Initialize configuration
  loadCloudConfig();
  openLocalDatabase().catch(err => console.warn('Circuitech local storage ready:', err));

  return {
    register: registerUser,
    login: authenticateUser,
    getSession: getSession,
    logout: clearSession,
    setCloudConfig: setCloudConfig,
    getCloudConfig: getCloudConfig,
    isCloudActive: isCloudActive
  };
})();

window.SecurityDB = SecurityDB;
