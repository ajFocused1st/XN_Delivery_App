(function () {
  'use strict';

  const STORAGE_KEY = 'xn_user';

  function computeBackendUrl() {
    const hostname = window.location.hostname;
    const isLocalHost = window.location.protocol === 'file:' ||
      hostname === '' ||
      ['localhost', '127.0.0.1', '::1'].includes(hostname) ||
      hostname.endsWith('.local') ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.');

    if (isLocalHost) {
      return 'http://localhost:10000';
    }

    return 'https://delivery-quote-backend.onrender.com';
  }

  const BACKEND_URL = computeBackendUrl();

  function normalizeEmailOrThrow(value) {
    const normalizedEmail = window.XNEmailValidation?.normalizeEmail(value);
    if (!normalizedEmail) {
      throw new Error('Please enter a valid email address.');
    }
    return normalizedEmail;
  }

  function readUserFromStorage() {
    const keysToCheck = [STORAGE_KEY, 'user'];
    for (const key of keysToCheck) {
      const raw = localStorage.getItem(key);
      if (!raw) {
        continue;
      }
      try {
        const parsed = JSON.parse(raw);
        if (key !== STORAGE_KEY) {
          localStorage.removeItem(key);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
        }
        return parsed;
      } catch (error) {
        console.warn('Failed to parse stored user profile from', key, error);
        localStorage.removeItem(key);
      }
    }
    return null;
  }

  function saveUserToStorage(user) {
    if (!user || typeof user !== 'object') {
      throw new Error('Cannot persist an invalid user profile.');
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  }

  function clearStoredUser() {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem('user');
  }

  async function postJson(path, payload) {
    const response = await fetch(`${BACKEND_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      console.warn('Response did not contain JSON data:', error);
    }

    return { response, data };
  }

  async function signupUser(payload) {
    const normalizedPayload = {
      ...payload,
      email: normalizeEmailOrThrow(payload?.email),
    };
    const { response, data } = await postJson('/api/signup', normalizedPayload);
    if (!response.ok) {
      const message = data?.message || 'Failed to create account.';
      throw Object.assign(new Error(message), { response, data });
    }
    return data;
  }

  async function loginUser(payload) {
    const normalizedPayload = {
      ...payload,
      email: normalizeEmailOrThrow(payload?.email),
    };
    const { response, data } = await postJson('/api/login', normalizedPayload);
    if (!response.ok) {
      const message = data?.message || 'Failed to log in.';
      throw Object.assign(new Error(message), { response, data });
    }
    if (!data?.user) {
      throw new Error('Login succeeded but no user profile was returned.');
    }
    return data;
  }

  function redirectToDashboard(role) {
    const hash = role ? `#${role}` : '';
    window.location.href = `dashboard.html${hash}`;
  }

  function requireAuth(options = {}) {
    const user = readUserFromStorage();
    const redirectTo = options.redirectTo === undefined ? 'index.html' : options.redirectTo;
    if (!user) {
      if (redirectTo) {
        window.location.href = redirectTo;
      }
      return null;
    }

    if (Array.isArray(options.allowedRoles) && !options.allowedRoles.includes(user.role)) {
      if (typeof options.onDenied === 'function') {
        options.onDenied(user);
      }
      if (redirectTo) {
        window.location.href = redirectTo;
      }
      return null;
    }

    return user;
  }

  window.XNAuth = {
    backendUrl: BACKEND_URL,
    signup: signupUser,
    login: loginUser,
    saveUser: saveUserToStorage,
    getUser: readUserFromStorage,
    clearUser: clearStoredUser,
    redirectToDashboard,
    requireAuth,
    STORAGE_KEY,
  };
})();
