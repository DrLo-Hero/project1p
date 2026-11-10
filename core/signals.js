'use strict';
// Signal-and-connector layer. Knows nothing about goals.
// Turns raw inputs (email, .ics, wearables, logs) into Signals that obey one contract.
// The engine only ever sees Signals — never a raw message body.
//
// Node gets module.exports; the browser gets window.P1.signals. The wrapper keeps every
// top-level name here out of index.html's global scope.
(function (root) {
'use strict';
const isNode = typeof module === 'object' && !!module.exports;
const R = isNode ? require('../rules.js') : root; // findDate / findTime / addDays / weekdayOf (globals in the browser)

const VERSION = 'signals-1';
const AUTHORITY = ['user', 'provider', 'third_party', 'inferred'];
const TYPES = ['email', 'calendar_change', 'readiness', 'session_log', 'journal', 'metric', 'finance', 'feedback'];

/** The contract. Returns a list of problems; empty = valid. */
function validateSignal(s) {
  if (!s || typeof s !== 'object') return ['not an object'];
  const errs = [];
  if (!s.source || typeof s.source !== 'string') errs.push('source');
  if (!TYPES.includes(s.type)) errs.push(`type (one of ${TYPES.join(', ')})`);
  if (!Number.isFinite(s.timestamp)) errs.push('timestamp (epoch ms)');
  if (!s.idempotencyKey || typeof s.idempotencyKey !== 'string') errs.push('idempotencyKey');
  if (!s.subject || typeof s.subject !== 'object') errs.push('subject (session/event/goal ref)');
  if (!s.payload || typeof s.payload !== 'object') errs.push('payload');
  if (!(s.confidence >= 0 && s.confidence <= 1)) errs.push('confidence (0..1)');
  if (!AUTHORITY.includes(s.authority)) errs.push(`authority (one of ${AUTHORITY.join(', ')})`);
  return errs;
}

// ---------- time zones ----------
// Instants are epoch ms. Wall-clock lives only at the edges, always with an IANA zone.

const fmts = new Map();
function fmt(tz) {
  if (!fmts.has(tz)) {
    fmts.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return fmts.get(tz);
}
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const pad = n => String(n).padStart(2, '0');

function zoned(ms, tz) {
  const p = {};
  for (const { type, value } of fmt(tz).formatToParts(new Date(ms))) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, wd: WD[p.weekday] };
}
function offsetMs(ms, tz) {
  const z = zoned(ms, tz);
  return Date.UTC(z.y, z.m - 1, z.d, z.h, z.mi, z.s) - Math.floor(ms / 1000) * 1000;
}
/** Wall-clock in a zone -> instant. Two passes settle DST edges. */
function zonedToUtc(y, m, d, h, mi, tz) {
  const wall = Date.UTC(y, m - 1, d, h, mi);
  let t = wall - offsetMs(wall, tz);
  const o = offsetMs(t, tz);
  if (wall - o !== t) t = wall - o;
  return t;
}
function dayKey(ms, tz) { const z = zoned(ms, tz); return `${z.y}-${pad(z.m)}-${pad(z.d)}`; }
function atLocal(key, hhmm, tz) {
  const [y, m, d] = key.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return zonedToUtc(y, m, d, h, mi, tz);
}
function localLabel(ms, tz) { const z = zoned(ms, tz); return `${dayKey(ms, tz)} ${pad(z.h)}:${pad(z.mi)} ${tz}`; }
function isIANA(tz) {
  if (!tz || (tz !== 'UTC' && !tz.includes('/'))) return false;
  try { fmt(tz); return true; } catch { return false; }
}
function isDst(ms, tz) {
  const y = zoned(ms, tz).y;
  const jan = offsetMs(Date.UTC(y, 0, 1), tz), jul = offsetMs(Date.UTC(y, 6, 1), tz);
  return jan !== jul && offsetMs(ms, tz) === Math.max(jan, jul);
}

// Abbreviations are not zones. "EST" in July is either wrong or means EDT; either
// way a person has to say which, so every abbreviation comes back ambiguous.
const ABBR = {
  EST: ['America/New_York', false], EDT: ['America/New_York', true],
  CST: ['America/Chicago', false], CDT: ['America/Chicago', true],
  MST: ['America/Denver', false], MDT: ['America/Denver', true],
  PST: ['America/Los_Angeles', false], PDT: ['America/Los_Angeles', true],
  GMT: ['Europe/London', false], BST: ['Europe/London', true],
  CET: ['Europe/Paris', false], CEST: ['Europe/Paris', true],
  IST: [null, null], // India, Ireland and Israel all use it
};
const WINDOWS_TZ = {
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver', 'Pacific Standard Time': 'America/Los_Angeles',
  'GMT Standard Time': 'Europe/London', 'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
};

function resolveTz(name, atMs) {
  if (!name) return null;
  if (/^(UTC|Z|Etc\/UTC)$/i.test(name)) return { tz: 'UTC', ambiguous: false };
  if (isIANA(name)) return { tz: name, ambiguous: false };
  const abbr = ABBR[name.toUpperCase()];
  if (abbr) {
    const [tz, dst] = abbr;
    if (!tz) return { tz: null, ambiguous: true, note: `"${name}" names several zones` };
    let note = `"${name}" is an abbreviation, read as ${tz}`;
    if (atMs != null && isDst(atMs, tz) !== dst) note += `, but ${name} is not in effect on that date`;
    return { tz, ambiguous: true, note };
  }
  if (WINDOWS_TZ[name]) return { tz: WINDOWS_TZ[name], ambiguous: true, note: `"${name}" is a Windows zone name, read as ${WINDOWS_TZ[name]}` };
  return { tz: null, ambiguous: true, note: `unknown time zone "${name}"` };
}

// ---------- .ics ----------

const ICS_DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const unescapeText = v => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();
const mailto = v => v.replace(/^mailto:/i, '').trim().toLowerCase();

function splitLine(line) {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') q = !q;
    else if (line[i] === ':' && !q) return [line.slice(0, i), line.slice(i + 1)];
  }
  return null;
}

function parseDateProp(value, prm, userTz) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  if (!h || prm.VALUE === 'DATE') {
    const key = `${y}-${mo}-${d}`;
    return { allDay: true, key, ms: atLocal(key, '00:00', userTz), tz: userTz };
  }
  if (z) return { ms: Date.UTC(+y, mo - 1, +d, +h, +mi), tz: 'UTC', ambiguous: false };
  if (prm.TZID) {
    const r = resolveTz(prm.TZID, Date.UTC(+y, mo - 1, +d, +h, +mi));
    const tz = r.tz || userTz;
    return { ms: zonedToUtc(+y, +mo, +d, +h, +mi, tz), tz, ambiguous: r.ambiguous || !r.tz, note: r.note || null };
  }
  // Floating time: RFC 5545 says "local to whoever reads it", so the user's zone.
  return { ms: zonedToUtc(+y, +mo, +d, +h, +mi, userTz), tz: userTz, floating: true, ambiguous: false };
}

function parseDuration(v) {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v);
  if (!m) return null;
  const [, w, d, h, mi, s] = m.map(x => +x || 0);
  return ((((w * 7 + d) * 24 + h) * 60 + mi) * 60 + s) * 1000;
}

function parseICS(text, userTz = 'UTC') {
  const lines = String(text).replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const cal = { method: null, events: [] };
  let ev = null, depth = 0;
  for (const line of lines) {
    const sp = splitLine(line);
    if (!sp) continue;
    const [head, value] = sp;
    const [rawName, ...ps] = head.split(';');
    const name = rawName.toUpperCase();
    const prm = {};
    for (const p of ps) { const i = p.indexOf('='); if (i > 0) prm[p.slice(0, i).toUpperCase()] = p.slice(i + 1).replace(/^"|"$/g, ''); }
    const v = value.trim();
    if (name === 'BEGIN') {
      if (v.toUpperCase() === 'VEVENT') { ev = { attendees: [], exdates: [], sequence: 0, status: 'CONFIRMED' }; depth = 0; }
      else if (ev) depth++; // VALARM and friends: their fields are not the event's
      continue;
    }
    if (name === 'END') {
      if (v.toUpperCase() === 'VEVENT' && ev) { cal.events.push(finishEvent(ev)); ev = null; }
      else if (ev) depth--;
      continue;
    }
    if (!ev) { if (name === 'METHOD') cal.method = v.toUpperCase(); continue; }
    if (depth > 0) continue;
    switch (name) {
      case 'UID': ev.uid = v; break;
      case 'SUMMARY': ev.title = unescapeText(value); break;
      case 'LOCATION': ev.location = unescapeText(value); break;
      case 'DTSTART': ev.start = parseDateProp(v, prm, userTz); break;
      case 'DTEND': ev.end = parseDateProp(v, prm, userTz); break;
      case 'DURATION': ev.duration = parseDuration(v); break;
      case 'RRULE': ev.rrule = v.toUpperCase(); break;
      case 'EXDATE': for (const x of v.split(',')) { const d = parseDateProp(x, prm, userTz); if (d) ev.exdates.push(d.ms); } break;
      case 'RECURRENCE-ID': ev.recurrenceId = parseDateProp(v, prm, userTz); break;
      case 'SEQUENCE': ev.sequence = +v || 0; break;
      case 'STATUS': ev.status = v.toUpperCase(); break;
      case 'ORGANIZER': ev.organizer = mailto(v); break;
      case 'ATTENDEE': ev.attendees.push({ email: mailto(v), name: prm.CN || null, partstat: (prm.PARTSTAT || 'NEEDS-ACTION').toUpperCase(), rsvp: /^true$/i.test(prm.RSVP || '') }); break;
      // DESCRIPTION is deliberately ignored: it is sender-controlled free text.
    }
  }
  return cal;
}

function finishEvent(ev) {
  if (ev.start && !ev.end) {
    const ms = ev.duration != null ? ev.start.ms + ev.duration : ev.start.allDay ? ev.start.ms + 864e5 : ev.start.ms;
    ev.end = { ...ev.start, ms };
  }
  ev.rruleSupported = rruleSupported(ev.rrule);
  return ev;
}

// ---------- recurrence ----------
// Supported: FREQ=DAILY|WEEKLY|MONTHLY, INTERVAL, COUNT, UNTIL, plain BYDAY, BYMONTHDAY.
// Anything else is flagged unsupported and never auto-committed.

const RR_KEYS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'WKST']);
function parseRRule(str) {
  const r = {};
  for (const part of String(str || '').split(';')) { const [k, v] = part.split('='); if (k) r[k.toUpperCase()] = v; }
  return r;
}
function rruleSupported(str) {
  if (!str) return true;
  const r = parseRRule(str);
  return Object.keys(r).every(k => RR_KEYS.has(k)) && ['DAILY', 'WEEKLY', 'MONTHLY'].includes(r.FREQ) && !/\d/.test(r.BYDAY || '');
}
function untilStamp(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
function withUntil(rrule, ms) {
  const keep = String(rrule).split(';').filter(p => !/^(UNTIL|COUNT)=/i.test(p));
  return [...keep, `UNTIL=${untilStamp(ms)}`].join(';');
}

/**
 * Instances of an event between from and to. Wall-clock is kept across DST: a 09:00
 * weekly meeting stays 09:00 local and its absolute time shifts.
 * ev: { start, end, tz, rrule, exdates, overrides: { [originalStart]: {start,end,...} } }
 */
function expand(ev, { from = -Infinity, to = Infinity, max = 500 } = {}) {
  const dur = ev.end - ev.start;
  if (!ev.rrule) return ev.start < to && ev.end > from ? [{ start: ev.start, end: ev.end, instance: ev.start }] : [];
  const r = parseRRule(ev.rrule), tz = ev.tz || 'UTC', w = zoned(ev.start, tz);
  const startKey = `${w.y}-${pad(w.m)}-${pad(w.d)}`;
  const interval = +r.INTERVAL || 1, count = r.COUNT ? +r.COUNT : Infinity;
  const until = r.UNTIL ? parseDateProp(r.UNTIL, {}, tz).ms : Infinity;
  const byday = r.BYDAY ? r.BYDAY.split(',').map(d => ICS_DAYS[d.trim()]) : [w.wd];
  const bymd = r.BYMONTHDAY ? +r.BYMONTHDAY : w.d;
  const monOffset = (w.wd + 6) % 7;
  const ex = new Set(ev.exdates || []);
  const out = [];
  let n = 0;
  for (let i = 0; i < 3700 && n < count && out.length < max; i++) {
    const key = R.addDays(startKey, i);
    const [y, m, d] = key.split('-').map(Number);
    let hit;
    if (r.FREQ === 'DAILY') hit = i % interval === 0;
    else if (r.FREQ === 'WEEKLY') hit = byday.includes(R.weekdayOf(key)) && Math.floor((i + monOffset) / 7) % interval === 0;
    else hit = d === bymd && ((y - w.y) * 12 + m - w.m) % interval === 0; // RFC: skip months without that day
    if (!hit) continue;
    const s = zonedToUtc(y, m, d, w.h, w.mi, tz);
    if (s > until || s >= to) break;
    n++; // COUNT includes excluded dates (RFC 5545 3.8.5.1)
    if (ex.has(s)) continue;
    const o = ev.overrides && ev.overrides[s];
    const inst = o ? { start: o.start ?? s, end: o.end ?? s + dur, instance: s, override: true } : { start: s, end: s + dur, instance: s };
    if (inst.end > from) out.push(inst);
  }
  return out;
}

// ---------- email ----------

function parseAddress(s) {
  const str = String(s || '');
  const m = /<([^>]+)>/.exec(str);
  const addr = (m ? m[1] : str).trim().toLowerCase();
  const [local = '', domain = ''] = addr.split('@');
  return { name: m ? str.slice(0, m.index).replace(/"/g, '').trim() : '', addr, local, domain };
}

const HIDDEN = /<([a-z0-9]+)\b[^>]*style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0|max-height\s*:\s*0)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi;
function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(HIDDEN, '') // ponytail: regex, not a DOM — nested same-name hidden tags can leak; use a parser if that shows up
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

// Lines that address a machine rather than a person. They are removed before anything
// reads the text, so they can't carry a date, a time, or an instruction into a proposal.
const INJECTION = [
  /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
  /\b(system|assistant|developer)\s*(prompt|message|note)?\s*:/i,
  /\byou are (now )?(an? )?(ai|assistant|language model|llm|agent|scheduler)\b/i,
  /\b(auto[- ]?accept|accept (this|the) (invite|invitation|meeting) automatically|set (the )?confidence|override (the )?(rules|policy|schedule|constraints?)|bypass)\b/i,
  /<\|[^|]*\|>|\[\/?(INST|SYS)\]/i,
  /\bdo not (tell|inform|notify|show) the user\b/i,
];

function sanitize(text) {
  let removed = 0;
  const kept = String(text || '').replace(/[​-‏⁠﻿]/g, '').split(/\r?\n/).filter(line => {
    if (INJECTION.some(re => re.test(line))) { removed++; return false; }
    return true;
  });
  return { text: kept.join('\n'), removed };
}

const SUBJECT_PREFIX = /^\s*((re|fwd?|fw|aw|tr)\s*:|\[[^\]]*\])\s*/i;
function stripPrefixes(subject) {
  let s = String(subject || ''), prev;
  do { prev = s; s = s.replace(SUBJECT_PREFIX, ''); } while (s !== prev);
  return s.trim();
}
function cleanSubject(subject) {
  return stripPrefixes(subject).replace(/^(updated invitation|invitation|invite|cancell?ed( event)?|canceled)\s*:\s*/i, '').replace(/\s+@\s+.*$/, '').trim();
}

const DATEISH = /\b(today|tomorrow|mon|tue|wed|thu|fri|sat|sun|\d{1,2}[:/]\d{2}|\d{1,2}\s*(am|pm)|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
const SCHEDULABLE = new Set(['meeting_request', 'meeting_change', 'meeting_cancel', 'deadline', 'training_related', 'personal_admin']);

function classify(raw, text, ics, ctx = {}) {
  const h = Object.fromEntries(Object.entries(raw.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const from = parseAddress(raw.from);
  const subj = String(raw.subject || ''), base = stripPrefixes(subj);
  const all = `${subj}\n${text}`;
  const ev = ics && ics.events[0];
  const tags = new Set();
  if ((ctx.trustedDomains || []).includes(from.domain)) tags.add('from_trusted_domain');
  if ((raw.attachments || []).length) tags.add('attachment_present');
  if (ics) tags.add('has_ics');
  if ((ev && ev.location) || /^\s*(location|where|room|venue|address)\s*:/im.test(text)) tags.add('has_location');
  if ((ev && ev.rrule) || /\b(every (day|week|other|mon|tue|wed|thu|fri|sat|sun)\w*|weekly|fortnightly)\b/i.test(all)) tags.add('recurring');
  if ((ev && ev.status === 'TENTATIVE') || /\b(tentative(ly)?|tbc|tbd|pencil(led)? in|provisional)\b/i.test(all)) tags.add('tentative');
  const ooo = /\b(out of (the )?office|on (annual )?leave|away until)\b/i.test(all);
  const auto = (h['auto-submitted'] && h['auto-submitted'] !== 'no') || 'x-autoreply' in h || 'x-autorespond' in h || /^(automatic reply|auto(-|\s)?reply)/i.test(base);
  if (ooo) tags.add('out_of_office');
  if (auto) tags.add('auto_reply');
  const list = !!(h['list-id'] || h['list-unsubscribe'] || /^(bulk|list)$/i.test(h.precedence || ''));
  const automatedSender = /^(no-?reply|do-?not-?reply|notifications?|mailer-daemon|bounces?|alerts?)\b/.test(from.local);

  const authFail = /\b(spf|dkim|dmarc)=(fail|softfail)/i.test(h['authentication-results'] || '');
  const phishy = /\b(verify your (account|identity)|confirm your password|account (is |has been )?suspended|gift cards?|wire transfer|urgent payment|crypto(currency)? wallet|unusual sign-?in)\b/i.test(all);
  const spoof = /@/.test(from.name) && !from.name.toLowerCase().includes(from.domain);
  const optedIn = (ctx.optInSenders || []).includes(from.addr);

  let cls;
  if (authFail || phishy || spoof) cls = 'spam_phish';
  else if ((ics && (ics.method === 'CANCEL' || (ev && ev.status === 'CANCELLED'))) || /^(cancell?ed|canceled event|cancellation)\b/i.test(base)) cls = 'meeting_cancel';
  else if (ics && ((ev && ev.sequence > 0) || /^(updated invitation|rescheduled)/i.test(base))) cls = 'meeting_change';
  else if (ics || /^(invitation|invite)\b/i.test(base)) cls = 'meeting_request';
  else if (list) cls = 'newsletter';
  else if ((automatedSender && !optedIn) || auto || ooo) cls = 'notification'; // opting in a no-reply sender (bookings) makes it schedulable
  else if (/\b(rescheduled?|moved to|new time)\b/i.test(all) && DATEISH.test(text)) cls = 'meeting_change';
  else if (/\b(due|deadline|submit(ted)? by|no later than|closes on)\b/i.test(all)) cls = 'deadline';
  else if (/\b(training|workout|race|coach|gym|swim|ride|lift(ing)?|run club)\b/i.test(all)) cls = 'training_related';
  else if (/\b(meet|meeting|call|catch up|coffee|lunch|sync)\b/i.test(all) && DATEISH.test(text)) cls = 'meeting_request';
  else if (/\b(appointment|dentist|doctor|gp|renewal|bill|invoice|tax|insurance|bank)\b/i.test(all)) cls = 'personal_admin';
  else cls = 'irrelevant';

  return { class: cls, tags: [...tags].sort(), excluded: (list || automatedSender || ooo || auto) && !optedIn, from };
}

const HEADER_LINE = /^\s*>?\s*(sent|date|from|to|cc|subject)\s*:/i;
const TZ_TOKEN = /\b([A-Z][a-z]+(?:_[A-Z][a-z]+)*\/[A-Za-z_]+(?:\/[A-Za-z_]+)?|UTC|GMT|[ECMP][SD]T|BST|CES?T|IST)\b/;

/** Date/time from the sanitized body. Relative dates resolve against today in the user's zone. */
function bodyWhen(text, userTz, now) {
  const z = zoned(now, userTz);
  const anchor = new Date(z.y, z.m - 1, z.d, 12); // a local Date carrying the user's y/m/d, for rules.js
  for (const line of text.split('\n')) {
    if (HEADER_LINE.test(line)) continue; // "Sent: Monday 9 Nov" is when the mail left, not the meeting
    const found = R.findDate(line, anchor);
    if (!found) continue;
    const rest = line.split(found.text).join(' ');
    const time = R.findTime(rest);
    const y = found.date.getFullYear(), m = found.date.getMonth() + 1, d = found.date.getDate();
    const key = `${y}-${pad(m)}-${pad(d)}`;
    if (!time) return { allDay: true, deadline: key, start: atLocal(key, '00:00', userTz), end: atLocal(R.addDays(key, 1), '00:00', userTz), senderTz: null, tzSource: 'none' };
    const tok = TZ_TOKEN.exec(rest.slice(rest.indexOf(time.text)));
    const r = tok ? resolveTz(tok[1], Date.UTC(y, m - 1, d, time.hour, time.minute)) : null;
    const tz = (r && r.tz) || userTz;
    const start = zonedToUtc(y, m, d, time.hour, time.minute, tz);
    return {
      allDay: false, start, end: start + 3600e3, assumedDuration: true, senderTz: tok ? tz : null,
      tzSource: tok ? 'explicit' : 'assumed_user', tzAmbiguous: !!(r && r.ambiguous), tzNote: r ? r.note || null : null,
    };
  }
  return null;
}

function softConstraints(text) {
  const out = [];
  const re = /\b(if possible|flexible|any ?time (this|next) week|no rush|(before|after|not before|not after) \d{1,2}(:\d{2})?\s*(am|pm)?)\b/gi;
  let m;
  while ((m = re.exec(text))) out.push(m[0].toLowerCase());
  return [...new Set(out)];
}

function domainHint(text, domains = []) {
  const lower = text.toLowerCase();
  let best = null, hits = 0;
  for (const d of domains) {
    const n = (d.keywords || []).filter(k => k && new RegExp(`\\b${k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)).length;
    if (n > hits) { best = d.id; hits = n; }
  }
  return best;
}

function confidenceOf(cls, x, excluded) {
  if (!SCHEDULABLE.has(cls) || excluded) return 0;
  if (x.path === 'ics') return x.tzAmbiguous || !x.rruleSupported ? 0.85 : 0.97;
  if (x.path === 'body' || x.path === 'model') {
    if (x.allDay) return 0.72;
    if (x.tzSource === 'explicit') return x.tzAmbiguous ? 0.8 : 0.88;
    return 0.75;
  }
  return 0.3;
}

/**
 * Raw email -> Signal. ctx: { tz, now, trustedDomains, optInSenders, domains, accountId, extractor }.
 * `extractor` is an optional model-based body extractor: it receives sanitized text only,
 * never the raw body. If it fails, the deterministic rules take over and say so.
 */
async function normalizeEmail(raw, ctx = {}) {
  const tz = ctx.tz || 'UTC', now = ctx.now ?? Date.now();
  const { text, removed } = sanitize([raw.text || '', raw.html ? htmlToText(raw.html) : ''].filter(Boolean).join('\n'));
  const subject = sanitize(raw.subject || '').text;
  const att = (raw.attachments || []).find(a => /calendar/i.test(a.mime || '') || /\.ics$/i.test(a.filename || ''));
  const ics = raw.ics || (att && att.content) ? parseICS(raw.ics || att.content, tz) : null;
  const c = classify({ ...raw, subject }, text, ics, ctx);

  let body = null, path = 'rules', meta = null;
  if (ctx.extractor && !c.excluded && c.class !== 'spam_phish') {
    const t0 = Date.now();
    try {
      const r = await ctx.extractor({ subject, text, tz, now });
      body = r && r.fields ? { ...r.fields, viaModel: true } : null;
      path = 'model';
      meta = { latencyMs: Date.now() - t0, costUsd: (r && r.costUsd) || 0 };
    } catch (e) {
      path = 'rules_fallback';
      meta = { latencyMs: Date.now() - t0, error: String(e.message || e) };
    }
  }
  // The fallback covers a defined subset only: .ics invites and obvious meeting requests.
  if (!body && (path !== 'rules_fallback' || ['meeting_request', 'meeting_change'].includes(c.class))) body = bodyWhen(text, tz, now);

  const ev = ics && (ics.events.find(e => !e.recurrenceId) || ics.events[0]);
  const x = {
    title: null, start: null, end: null, allDay: false, deadline: null, tz, senderTz: null,
    tzAmbiguous: false, tzNote: null, location: null, participants: [], organizer: null,
    recurrence: null, rruleSupported: true, exdates: [], rsvpRequired: false, icsUid: null,
    sequence: 0, method: ics ? ics.method : null, recurrenceId: null, status: null,
    threadId: raw.threadId || raw.id, conflicts: [], path: 'none',
    softConstraints: softConstraints(text), domainHint: domainHint(`${subject}\n${text}`, ctx.domains),
  };
  if (ev && ev.start) {
    Object.assign(x, {
      title: ev.title || null, start: ev.start.ms, end: ev.end.ms, allDay: !!ev.start.allDay,
      deadline: ev.start.allDay ? ev.start.key : null, senderTz: ev.start.tz,
      tzAmbiguous: !!ev.start.ambiguous, tzNote: ev.start.note || null, location: ev.location || null,
      organizer: ev.organizer || null, participants: ev.attendees.map(a => a.email),
      recurrence: ev.rrule || null, rruleSupported: ev.rruleSupported, exdates: ev.exdates,
      rsvpRequired: ev.attendees.some(a => a.rsvp), icsUid: ev.uid || null, sequence: ev.sequence,
      recurrenceId: ev.recurrenceId ? ev.recurrenceId.ms : null, status: ev.status, path: 'ics',
    });
    // The .ics is the machine-readable truth; the prose is a human paraphrase of it.
    if (body && body.start != null && !body.allDay && !x.allDay && Math.abs(body.start - x.start) >= 60e3) {
      x.conflicts.push({ field: 'start', ics: x.start, body: body.start, kept: 'ics' });
    }
  } else if (body) {
    Object.assign(x, body, { path: body.viaModel ? 'model' : 'body' });
    delete x.viaModel;
  }
  x.title = x.title || cleanSubject(subject) || 'Untitled';
  if (!x.participants.length) x.participants = [raw.from, ...[].concat(raw.to || [], raw.cc || [])].map(a => parseAddress(a).addr).filter(Boolean);
  x.organizer = x.organizer || c.from.addr;
  x.display = x.start == null ? null : {
    user: localLabel(x.start, tz),
    sender: x.senderTz && x.senderTz !== tz ? localLabel(x.start, x.senderTz) : null,
  };

  const quarantined = c.class === 'spam_phish';
  return {
    type: 'email', source: `email:${ctx.accountId || 'default'}`, idempotencyKey: `email:${raw.id}`,
    timestamp: Date.parse(raw.date) || now, authority: 'third_party',
    confidence: quarantined ? 0 : confidenceOf(c.class, x, c.excluded),
    subject: { messageId: raw.id, threadId: x.threadId, icsUid: x.icsUid },
    payload: {
      rulesVersion: VERSION, class: c.class, tags: c.tags, excluded: c.excluded, quarantined,
      from: c.from.addr, fromDomain: c.from.domain, trusted: c.tags.includes('from_trusted_domain'),
      subjectLine: subject, summary: ['newsletter', 'notification'].includes(c.class) ? subject.slice(0, 140) : null,
      extraction: quarantined ? null : x, injectionLinesRemoved: removed, path, meta,
    },
  };
}

const api = {
  VERSION, TYPES, SCHEDULABLE, validateSignal,
  zoned, zonedToUtc, offsetMs, dayKey, atLocal, localLabel, isIANA, resolveTz,
  parseICS, parseRRule, rruleSupported, withUntil, expand,
  parseAddress, htmlToText, sanitize, classify, normalizeEmail, stripPrefixes,
};
if (isNode) module.exports = api; else (root.P1 = root.P1 || {}).signals = api;
})(typeof globalThis === 'object' ? globalThis : this);
