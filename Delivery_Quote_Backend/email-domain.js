'use strict';

const { promises: dns } = require('node:dns');

const DEFAULT_TIMEOUT_MS = 3000;
const POSITIVE_CACHE_TTL_MS = 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const domainCache = new Map();

class EmailDomainLookupError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'EmailDomainLookupError';
    this.cause = cause;
  }
}

function getDomain(email) {
  if (typeof email !== 'string') return null;
  const atIndex = email.lastIndexOf('@');
  return atIndex > 0 && atIndex < email.length - 1
    ? email.slice(atIndex + 1).toLowerCase()
    : null;
}

function hasUsableMailExchange(records) {
  return Array.isArray(records) && records.some(record => {
    if (!record || typeof record.exchange !== 'string') return false;
    return record.exchange.trim().replace(/\.$/, '').length > 0;
  });
}

function cacheResult(domain, acceptsMail, now) {
  if (domainCache.size >= MAX_CACHE_ENTRIES && !domainCache.has(domain)) {
    domainCache.delete(domainCache.keys().next().value);
  }
  domainCache.set(domain, {
    acceptsMail,
    expiresAt: now + (acceptsMail ? POSITIVE_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS),
  });
}

function isDefinitiveMissingDomain(error) {
  return ['ENODATA', 'ENOTFOUND', 'ENXDOMAIN'].includes(error?.code);
}

async function resolveMxWithTimeout(domain, resolveMx, timeoutMs) {
  let timeoutId;
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error('MX lookup timed out.');
      error.code = 'ETIMEOUT';
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => resolveMx(domain)),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function emailDomainAcceptsMail(email, options = {}) {
  const domain = getDomain(email);
  if (!domain) return false;

  const now = options.now ?? Date.now();
  const cached = domainCache.get(domain);
  if (cached && cached.expiresAt > now) return cached.acceptsMail;
  if (cached) domainCache.delete(domain);

  const resolveMx = options.resolveMx || dns.resolveMx;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const records = await resolveMxWithTimeout(domain, resolveMx, timeoutMs);
    const acceptsMail = hasUsableMailExchange(records);
    cacheResult(domain, acceptsMail, now);
    return acceptsMail;
  } catch (error) {
    if (isDefinitiveMissingDomain(error)) {
      cacheResult(domain, false, now);
      return false;
    }
    throw new EmailDomainLookupError(`Could not check mail service for ${domain}.`, error);
  }
}

function clearEmailDomainCache() {
  domainCache.clear();
}

module.exports = {
  EmailDomainLookupError,
  clearEmailDomainCache,
  emailDomainAcceptsMail,
  getDomain,
  hasUsableMailExchange,
};
