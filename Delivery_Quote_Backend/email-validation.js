'use strict';

const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;
const LOCAL_PART_PATTERN = /^[A-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i;
const DOMAIN_LABEL_PATTERN = /^[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?$/i;
const TOP_LEVEL_DOMAIN_PATTERN = /^(?:[A-Z]{2,63}|XN--[A-Z0-9-]{2,59})$/i;

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH) return null;
  const atIndex = email.indexOf('@');
  if (atIndex <= 0 || atIndex !== email.lastIndexOf('@')) return null;
  const localPart = email.slice(0, atIndex);
  const labels = email.slice(atIndex + 1).split('.');
  if (localPart.length > MAX_LOCAL_PART_LENGTH || !LOCAL_PART_PATTERN.test(localPart)) return null;
  if (labels.length < 2 || labels.some(label => !DOMAIN_LABEL_PATTERN.test(label))) return null;
  if (!TOP_LEVEL_DOMAIN_PATTERN.test(labels[labels.length - 1])) return null;
  return email;
}

module.exports = { normalizeEmail };
