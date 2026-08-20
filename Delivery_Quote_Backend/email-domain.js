'use strict';

const { promises: dns } = require('node:dns');
const domainCache = new Map();
const DEFAULT_TIMEOUT_MS = 3000;
const POSITIVE_CACHE_TTL_MS = 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

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
  return atIndex > 0 && atIndex < email.length - 1 ? email.slice(atIndex + 1).toLowerCase() : null;
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

async function emailDomainAcceptsMail(email, options = {}) {
  const domain = getDomain(email);
  if (!domain) return false;
  const now = options.now ?? Date.now();
  const cached = domainCache.get(domain);
  if (cached?.expiresAt > now) return cached.acceptsMail;
  if (cached) domainCache.delete(domain);
  const resolveMx = options.resolveMx || dns.resolveMx;
  let timeoutId;
  try {
    const records = await Promise.race([
      Promise.resolve().then(() => resolveMx(domain)),
      new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => reject(Object.assign(new Error('MX lookup timed out.'), { code: 'ETIMEOUT' })), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      }),
    ]);
    const acceptsMail = Array.isArray(records) && records.some(record =>
      typeof record?.exchange === 'string' && record.exchange.trim().replace(/\.$/, '').length > 0
    );
    cacheResult(domain, acceptsMail, now);
    return acceptsMail;
  } catch (error) {
    if (['ENODATA', 'ENOTFOUND', 'ENXDOMAIN'].includes(error?.code)) {
      cacheResult(domain, false, now);
      return false;
    }
    throw new EmailDomainLookupError(`Could not check mail service for ${domain}.`, error);
  } finally {
    clearTimeout(timeoutId);
  }
}

function clearEmailDomainCache() {
  domainCache.clear();
}

module.exports = { EmailDomainLookupError, clearEmailDomainCache, emailDomainAcceptsMail };
