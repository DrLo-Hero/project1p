'use strict';
// Pure rules: dates, schedules, streaks, money, and the two parsers that replace
// EventKit + NSDataDetector. No DOM, no storage — so test.js can run this in Node.
// Weekdays are 0..6 with 0 = Sunday, matching Date.getDay().

// ---------- dates ----------
// All date keys are local "YYYY-MM-DD". Never toISOString() — that's UTC and shifts
// the day for anyone west of Greenwich.

function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fromYMD(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function todayKey() { return ymd(new Date()); }

function addDays(key, n) {
  const d = fromYMD(key);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

function weekdayOf(key) { return fromYMD(key).getDay(); }

function daysInMonth(year, month /* 1-12 */) { return new Date(year, month, 0).getDate(); }

function monthKey(key) { return key.slice(0, 7); }

function startOfWeek(key) { return addDays(key, -weekdayOf(key)); }

// ---------- habits ----------

function goalOf(habit) {
  if (habit.kind === 'checkbox') return 1;
  if (habit.kind === 'checklist') return Math.max((habit.checklist || []).length, 1);
  return Math.max(habit.target || 1, 1);
}

function fraction(value, goal) {
  if (!(goal > 0)) return value > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, value / goal));
}

function isScheduled(habit, key) {
  switch (habit.schedule) {
    case 'daily':
      return true;
    case 'weekly':
    case 'custom': {
      const days = habit.weekdays || [];
      // An empty day list means "not configured yet", not "never".
      if (!days.length) return true;
      return days.includes(weekdayOf(key));
    }
    case 'monthly': {
      const d = fromYMD(key);
      const last = daysInMonth(d.getFullYear(), d.getMonth() + 1);
      // The 31st has to land somewhere in February or the habit skips a month.
      return d.getDate() === Math.min(habit.monthDay || 1, last);
    }
    default:
      return true;
  }
}

/** logValue(habitId, key) -> number. Injected so this stays free of storage. */
function streak(habit, logValue, fromKey, maxLookback = 730) {
  const goal = goalOf(habit);
  let count = 0;
  for (let offset = 0; offset < maxLookback; offset++) {
    const key = addDays(fromKey, -offset);
    if (!isScheduled(habit, key)) continue;
    if (fraction(logValue(habit.id, key), goal) >= 1) count++;
    else if (offset === 0) continue; // today is still open, not yet a miss
    else break;
  }
  return count;
}

/** Completion over the current period: the month for monthly habits, else this week. */
function periodProgress(habit, logValue, todayK) {
  const goal = goalOf(habit);
  let start, end;
  if (habit.schedule === 'monthly') {
    const d = fromYMD(todayK);
    start = ymd(new Date(d.getFullYear(), d.getMonth(), 1));
    end = ymd(new Date(d.getFullYear(), d.getMonth(), daysInMonth(d.getFullYear(), d.getMonth() + 1)));
  } else {
    start = startOfWeek(todayK);
    end = addDays(start, 6);
  }
  let done = 0, total = 0;
  for (let key = start; key <= end; key = addDays(key, 1)) {
    if (!isScheduled(habit, key)) continue;
    total++;
    if (fraction(logValue(habit.id, key), goal) >= 1) done++;
  }
  return { done, total };
}

// ---------- money ----------
// Expenses are stored negative, income positive.

function spend(amounts) { return -amounts.filter(a => a < 0).reduce((s, a) => s + a, 0); }
function income(amounts) { return amounts.filter(a => a > 0).reduce((s, a) => s + a, 0); }
function balance(opening, amounts) { return amounts.reduce((s, a) => s + a, opening); }
function sameMonth(keyA, keyB) { return monthKey(keyA) === monthKey(keyB); }

// ---------- text parsing ----------
// Replaces NSDataDetector, which has no web equivalent. Deliberately narrow: the
// patterns below and nothing else. Anything unmatched just isn't suggested.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const MONTH_RE = MONTHS.map(m => m.slice(0, 3)).join('|');
const WEEKDAY_RE = WEEKDAYS.join('|');

/** Pick the next occurrence when the year is left out, so "March 12" isn't in the past. */
function resolveYear(month, day, now) {
  const year = now.getFullYear();
  const candidate = new Date(year, month, day);
  return candidate < new Date(now.getFullYear(), now.getMonth(), now.getDate()) ? year + 1 : year;
}

function findTime(line) {
  let m = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(line);
  if (m) {
    let hour = Number(m[1]) % 12;
    if (m[3].toLowerCase() === 'pm') hour += 12;
    return { hour, minute: Number(m[2] || 0), text: m[0] };
  }
  m = /\b(\d{1,2}):(\d{2})\b/.exec(line);
  if (m) return { hour: Number(m[1]), minute: Number(m[2]), text: m[0] };
  return null;
}

/**
 * @param {string} line
 * @param {Date} now
 * @param {boolean} dayFirst  true = 12/03 is 12 March, false = 12 March -> Dec 3
 */
function findDate(line, now, dayFirst) {
  let m;

  if ((m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(line)))
    return { date: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), text: m[0] };

  if ((m = new RegExp(`\\b(${MONTH_RE})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'i').exec(line))) {
    const month = MONTHS.findIndex(x => x.startsWith(m[1].toLowerCase()));
    const day = Number(m[2]);
    const year = m[3] ? Number(m[3]) : resolveYear(month, day, now);
    return { date: new Date(year, month, day), text: m[0] };
  }

  if ((m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})[a-z]*\\.?(?:,?\\s+(\\d{4}))?\\b`, 'i').exec(line))) {
    const month = MONTHS.findIndex(x => x.startsWith(m[2].toLowerCase()));
    const day = Number(m[1]);
    const year = m[3] ? Number(m[3]) : resolveYear(month, day, now);
    return { date: new Date(year, month, day), text: m[0] };
  }

  if ((m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(line))) {
    const a = Number(m[1]), b = Number(m[2]);
    const day = dayFirst ? a : b;
    const month = (dayFirst ? b : a) - 1;
    let year = m[3] ? Number(m[3]) : resolveYear(month, day, now);
    if (year < 100) year += 2000;
    return { date: new Date(year, month, day), text: m[0] };
  }

  if ((m = /\b(today|tomorrow)\b/i.exec(line))) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (m[1].toLowerCase() === 'tomorrow') d.setDate(d.getDate() + 1);
    return { date: d, text: m[0] };
  }

  if ((m = new RegExp(`\\b(next\\s+)?(${WEEKDAY_RE})\\b`, 'i').exec(line))) {
    const target = WEEKDAYS.indexOf(m[2].toLowerCase());
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let delta = (target - d.getDay() + 7) % 7;
    if (delta === 0 || m[1]) delta += 7;
    d.setDate(d.getDate() + delta);
    return { date: d, text: m[0] };
  }

  return null;
}

/** "every Tuesday" / "each Friday" / "weekly" -> weekday index, else null. */
function recurringWeekday(line) {
  const lower = line.toLowerCase();
  if (!/\b(every|each|weekly)\b/.test(lower)) return null;
  const found = WEEKDAYS.findIndex(w => lower.includes(w));
  if (found >= 0) return found;
  return lower.includes('weekly') ? new Date().getDay() : null;
}

// Cutting "March 12" out of "Assignment 3 is due on March 12" leaves "is due on"
// dangling. Strip fillers from both ends until nothing more comes off — one pass
// isn't enough, because removing "due" exposes the "on" behind it.
const FILLER = /^(on|at|by|from|to|in|of|for|the|a|an|every|each|is|are|was|due|starts?|starting|begins?)$/i;

function cleanTitle(line, ...remove) {
  let out = String(line);
  for (const piece of remove) if (piece) out = out.split(piece).join(' ');

  const trim = s => s.replace(/^[\s\-–—:,.;]+|[\s\-–—:,.;]+$/g, '');
  let words = trim(out.replace(/\s+/g, ' ')).split(' ').filter(Boolean);

  let changed = true;
  while (changed && words.length) {
    changed = false;
    if (FILLER.test(trim(words[0]))) { words.shift(); changed = true; }
    if (words.length && FILLER.test(trim(words[words.length - 1]))) { words.pop(); changed = true; }
  }
  return trim(words.join(' '));
}

/** Pull dated lines out of pasted text. Returns suggestion objects. */
function parseText(text, now = new Date(), dayFirst = false) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const found = findDate(line, now, dayFirst);
    if (!found) continue;
    const time = findTime(line.split(found.text).join(' ')) || findTime(line);
    const when = new Date(found.date);
    if (time) when.setHours(time.hour, time.minute, 0, 0);
    const weekday = recurringWeekday(line);
    const title = cleanTitle(line, found.text, time && time.text) || 'Untitled';
    const key = `${title}|${when.getTime()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title,
      when: when.getTime(),
      weekday,
      kind: weekday === null ? 'task' : 'habit',
      source: 'Text',
    });
  }
  return out;
}

// ---------- .ics parsing ----------
// Replaces EventKit. Export from Google Calendar (Settings -> your calendar ->
// "Secret address in iCal format") or share any .ics into the app.

const ICS_DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseICSDate(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, utc] = m;
  if (!h) return new Date(Number(y), Number(mo) - 1, Number(d));
  if (utc) return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  return new Date(+y, +mo - 1, +d, +h, +mi, +s);
}

function parseICS(text) {
  // Unfold: continuation lines start with a space or tab.
  const unfolded = String(text).replace(/\r?\n[ \t]/g, '');
  const out = [];
  const seenSeries = new Set();

  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0];
    const field = name => {
      const m = new RegExp(`^${name}(?:;[^:\\r\\n]*)?:(.*)$`, 'im').exec(body);
      return m ? m[1].trim() : null;
    };
    const summary = (field('SUMMARY') || '').replace(/\\,/g, ',').replace(/\\n/gi, ' ').trim();
    const start = field('DTSTART');
    if (!summary || !start) continue;
    const when = parseICSDate(start);
    if (!when) continue;

    const uid = field('UID') || `${summary}|${start}`;
    const rrule = field('RRULE');
    const recurring = !!rrule;
    let weekday = null;
    if (recurring) {
      const byday = /BYDAY=([^;]+)/i.exec(rrule);
      if (byday) {
        const first = byday[1].split(',')[0].replace(/[^A-Z]/gi, '').slice(-2).toUpperCase();
        if (first in ICS_DAYS) weekday = ICS_DAYS[first];
      }
      if (weekday === null) weekday = when.getDay();
      // One suggestion per series, not one per occurrence. Keyed on UID, not the
      // title — two series can share a name, and one series can have edited titles.
      if (seenSeries.has(uid)) continue;
      seenSeries.add(uid);
    }

    out.push({
      title: summary,
      when: when.getTime(),
      weekday,
      kind: recurring ? 'habit' : 'task',
      source: 'Calendar file',
      uid,
    });
  }
  return out;
}

// ---------- the day's clock ----------
// Times are "HH:MM" strings, same as an <input type="time"> gives back. Anything
// without one is not guessed at — it goes in an "any time" bucket, because a habit
// you do whenever you get to it is not a habit at 09:00.

function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm == null ? '' : hhmm).trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// A declaration, not a const: rules.js is a classic script, and a top-level const is
// not a property of window. The app reaches these through window, so anything it calls
// has to be a declaration or be attached by hand below.
function hhmm(mins) {
  return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
}

/**
 * Lay items on an hour grid. items: [{ at }] where at is "HH:MM" or missing.
 * The window starts at [from..to] and widens to hold whatever is scheduled outside
 * it — a 05:30 run must not be invisible just because the day nominally starts at 6.
 * Returns { anytime, placed, hours: [{hour, items}], from, to }.
 */
function daySchedule(items, from = 6, to = 22) {
  const anytime = [], placed = [];
  for (const it of items || []) {
    const mins = minutesOf(it.at);
    if (mins == null) anytime.push(it);
    else placed.push(Object.assign({}, it, { mins, hour: Math.floor(mins / 60) }));
  }
  placed.sort((a, b) => a.mins - b.mins);
  for (const p of placed) {
    if (p.hour < from) from = p.hour;
    if (p.hour > to) to = p.hour;
  }
  from = Math.max(0, Math.min(23, from));
  to = Math.max(from, Math.min(23, to));
  const hours = [];
  for (let h = from; h <= to; h++) hours.push({ hour: h, items: placed.filter(p => p.hour === h) });
  return { anytime, placed, hours, from, to };
}

// ---------- one number for a day ----------
// The dashboard needs a portfolio value: a single figure that moves when any of the
// three tracks moves. Domains with nothing to say on a given day are left out of the
// average rather than scored zero — a day with no tasks due is not a day you failed
// at tasks, and the alternative punishes people for having a quiet Tuesday.
//
// Weights are habits 3, tasks 1, money 1. Habits are the spine of the app; the other
// two are the context it happens in.

/**
 * ctx: { habits, logValue, tasks, budget, spentTo(dayKey) -> spend since the 1st }
 * Returns { score, habits, tasks, money }, each 0..1 or null when the day is silent.
 */
function dayIndex(day, ctx) {
  const parts = [];

  const due = (ctx.habits || []).filter(h => !h.archived && isScheduled(h, day));
  const habits = due.length
    ? due.reduce((s, h) => s + fraction(ctx.logValue(h.id, day), goalOf(h)), 0) / due.length
    : null;
  if (habits != null) parts.push([habits, 3]);

  // completedAt is what makes this honest for past days. Records from before it was
  // written fall back to done, which reads a long-finished task as always finished.
  const dueTasks = (ctx.tasks || []).filter(x => x.due === day);
  const tasks = dueTasks.length
    ? dueTasks.filter(x => x.done && (!x.completedAt || x.completedAt <= day)).length / dueTasks.length
    : null;
  if (tasks != null) parts.push([tasks, 1]);

  let money = null;
  if (ctx.budget > 0 && ctx.spentTo) {
    const d = fromYMD(day);
    // Against the month's pro-rata share, not a flat daily cap: nobody spends in
    // equal daily instalments, and rent on the 1st shouldn't read as a disaster.
    const paced = ctx.budget * (d.getDate() / daysInMonth(d.getFullYear(), d.getMonth() + 1));
    const spent = ctx.spentTo(day);
    money = paced <= 0 ? 1 : spent <= paced ? 1 : Math.max(0, 1 - (spent - paced) / paced);
    parts.push([money, 1]);
  }

  // Learning is the only track that scores a silent day as a zero, and it earns that:
  // once a deck exists the forgetting curve runs whether you open the app or not.
  // Before the first card there is nothing to say, so it stays out of the average.
  let learn = null;
  if (ctx.deckFrom && day >= ctx.deckFrom) {
    const r = (ctx.reviews || {})[day];
    // ponytail: ten reviews is a full day. One knob, tune it if a deck gets big.
    learn = Math.min(1, ((r && r.n) || 0) / 10);
    parts.push([learn, 1]);
  }

  const weight = parts.reduce((s, p) => s + p[1], 0);
  return {
    score: weight ? parts.reduce((s, p) => s + p[0] * p[1], 0) / weight : null,
    habits, tasks, money, learn,
  };
}

/**
 * The scrub chart's data. Buckets so a year is ~60 points rather than 365 — the
 * chart is 340px wide and a phone finger is not 1px. Each bucket is the average of
 * its days, so a weekly point isn't just whatever happened on the Monday.
 * Silent days carry the previous value forward: your standing doesn't drop on a rest day.
 */
function indexSeries(fromKey, toKey, ctx, buckets = 60) {
  const days = Math.max(1, daysBetween(fromKey, toKey) + 1);
  const step = Math.max(1, Math.ceil(days / buckets));
  const keys = ['score', 'habits', 'tasks', 'money', 'learn'];
  const out = [];
  for (let i = 0; i < days; i += step) {
    const sum = { score: 0, habits: 0, tasks: 0, money: 0, learn: 0 };
    const seen = { score: 0, habits: 0, tasks: 0, money: 0, learn: 0 };
    let last = fromKey;
    for (let j = 0; j < step && i + j < days; j++) {
      last = addDays(fromKey, i + j);
      const x = dayIndex(last, ctx);
      for (const k of keys) if (x[k] != null) { sum[k] += x[k]; seen[k]++; }
    }
    const point = { key: last };
    for (const k of keys) point[k] = seen[k] ? sum[k] / seen[k] : null;
    out.push(point);
  }
  // Silent buckets inherit their neighbours instead of reading as zero — a week with
  // no tasks due is not a week of failed tasks. Carry forward, then back-fill the head
  // from the first real value, so the line never opens on a number nobody earned.
  for (const k of keys) {
    let carry = null;
    for (const p of out) { if (p[k] == null) p[k] = carry; else carry = p[k]; }
    carry = null;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i][k] == null) out[i][k] = carry; else carry = out[i][k];
    }
  }
  // A component still null was never recorded at all; the chart needs a number, the
  // per-track sparklines would rather show nothing.
  out.forEach(p => { if (p.score == null) p.score = 0; });
  return out;
}

// ---------- learning: spaced repetition ----------
// Leitner boxes, not SM-2. Spacing and retrieval are the findings that hold up
// (Ebbinghaus; Roediger & Karpicke); the ease-factor arithmetic on top of them is
// tuning, and for a deck one person writes by hand it lands inside the noise.
// ponytail: fixed intervals. Move to SM-2 only if a real deck outgrows them.
const BOXES = [1, 2, 4, 8, 16, 32, 64];

function reviewCard(card, grade, t) {
  const box = Math.max(0, Math.min(card.box || 0, BOXES.length - 1));
  // 'again' goes back to the front. A card you could not recall is a card you never
  // knew, and pretending otherwise is how a deck fills up with quiet failures.
  const next = grade === 'again' ? 0
    : grade === 'good' ? Math.min(box + 1, BOXES.length - 1)
      : box;
  return {
    box: next,
    due: addDays(t, BOXES[next]),
    seen: (card.seen || 0) + 1,
    lapses: (card.lapses || 0) + (grade === 'again' ? 1 : 0),
    last: t,
    grade,
  };
}

function dueCards(cards, t, limit) {
  const due = (cards || []).filter(c => !c.archived && (!c.due || c.due <= t));
  // Interleaving beats blocking, even though blocking feels far more productive:
  // deal round-robin across goals instead of marching through one subject at a time.
  const lanes = new Map();
  due.forEach(c => {
    const k = c.goalId || '';
    if (!lanes.has(k)) lanes.set(k, []);
    lanes.get(k).push(c);
  });
  // Oldest due first inside a lane — the most-forgotten card is worth the most.
  lanes.forEach(l => l.sort((a, b) =>
    String(a.due || '').localeCompare(String(b.due || '')) || String(a.id).localeCompare(String(b.id))));
  const keys = Array.from(lanes.keys());
  const out = [];
  for (let i = 0; out.length < due.length; i++) {
    const lane = lanes.get(keys[i % keys.length]);
    if (lane.length) out.push(lane.shift());
  }
  return limit ? out.slice(0, limit) : out;
}

function retention(cards, t) {
  const live = (cards || []).filter(c => !c.archived);
  const seen = live.filter(c => c.seen > 0);
  const reps = seen.reduce((s, c) => s + c.seen, 0);
  const missed = seen.reduce((s, c) => s + (c.lapses || 0), 0);
  return {
    total: live.length,
    due: dueCards(live, t).length,
    fresh: live.filter(c => !c.seen).length,
    // Box 3 is 8-day spacing: the point where a card has survived long enough to
    // count as known rather than freshly crammed.
    learned: live.filter(c => (c.box || 0) >= 3).length,
    leeches: live.filter(c => (c.lapses || 0) >= 4).length,
    recall: reps ? (reps - missed) / reps : null,
  };
}

// ---------- goals ----------
// A written aim with a date and a number on it. That is the part of every
// goal-setting book that survives contact with the evidence (Locke & Latham).
function goalPace(goal, done, t) {
  if (!goal || !goal.target || !goal.targetDate || !goal.created) return null;
  const span = daysBetween(goal.created, goal.targetDate);
  if (span <= 0) return null;
  const gone = Math.max(0, Math.min(span, daysBetween(goal.created, t)));
  const left = daysBetween(t, goal.targetDate);
  const expected = goal.target * (gone / span);
  return {
    pct: fraction(done, goal.target),
    expected,
    ahead: done - expected,
    remaining: Math.max(0, goal.target - done),
    daysLeft: left,
    perDay: left > 0 ? Math.max(0, goal.target - done) / left : null,
  };
}

// ---------- deliberate practice ----------
// Ericsson's finding compressed to two numbers: practice that never feels hard, and
// practice with no named target, are both just time spent.
function practiceTrend(sessions, n) {
  const last = (sessions || []).slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, n || 6);
  if (!last.length) return null;
  const rated = last.filter(s => s.difficulty > 0);
  return {
    count: last.length,
    minutes: last.reduce((s, x) => s + (x.minutes || 0), 0),
    difficulty: rated.length ? rated.reduce((s, x) => s + x.difficulty, 0) / rated.length : null,
    withFocus: last.filter(s => s.focus).length,
  };
}

// ---------- patterns in your own logs ----------

/**
 * Which habit, when you keep it, coincides with keeping everything else. Duhigg called
 * this a keystone habit on journalistic evidence; this measures the same claim against
 * your own logs, which is a different and more defensible thing. It is a correlation
 * and nothing more — the habit may be the cause, or both may be downstream of a good
 * week. Worth surfacing, not worth over-reading.
 */
function keystone(habits, logValue, endKey, days = 60) {
  const live = (habits || []).filter(h => !h.archived);
  if (live.length < 2) return null;
  const out = [];
  live.forEach(h => {
    const kept = [0, 0], missed = [0, 0]; // [others kept, others scheduled]
    for (let i = 0; i < days; i++) {
      const day = addDays(endKey, -i);
      if (!isScheduled(h, day)) continue;
      const others = live.filter(x => x.id !== h.id && isScheduled(x, day));
      if (!others.length) continue;
      const bucket = fraction(logValue(h.id, day), goalOf(h)) >= 1 ? kept : missed;
      others.forEach(x => {
        bucket[1]++;
        if (fraction(logValue(x.id, day), goalOf(x)) >= 1) bucket[0]++;
      });
    }
    // Both sides need enough days or the comparison is noise wearing a percentage sign.
    if (kept[1] < 10 || missed[1] < 10) return;
    const withIt = kept[0] / kept[1], without = missed[0] / missed[1];
    out.push({ habit: h, withIt, without, lift: withIt - without });
  });
  if (!out.length) return null;
  out.sort((a, b) => b.lift - a.lift);
  return out[0].lift >= 0.15 ? out[0] : null;
}

/**
 * Covey's quadrants, derived rather than asked for: priority is importance, and a task
 * whose due date had arrived by the time it was finished was urgent. No new field and
 * nothing extra to fill in.
 */
function quadrants(tasks, endKey, days = 30) {
  const from = addDays(endKey, -(days - 1));
  const q = { q1: 0, q2: 0, q3: 0, q4: 0 };
  (tasks || []).forEach(t => {
    if (!t.done) return;
    const when = t.completedAt || t.due;
    if (!when || when < from || when > endKey) return;
    const important = (t.priority || 0) >= 2;
    const urgent = !!(t.due && t.due <= when);
    q[important ? (urgent ? 'q1' : 'q2') : (urgent ? 'q3' : 'q4')]++;
  });
  const total = q.q1 + q.q2 + q.q3 + q.q4;
  q.total = total;
  q.share2 = total ? q.q2 / total : null;
  return q;
}

/** The moments behaviour change actually catches (Dai & Milkman, the fresh-start
    effect): a new week, month, year, or your birthday. */
function freshStart(t, birthday) {
  if (birthday && birthday.length >= 10 && birthday.slice(5) === t.slice(5)) return 'birthday';
  if (t.slice(5) === '01-01') return 'year';
  if (fromYMD(t).getDate() === 1) return 'month';
  if (weekdayOf(t) === 1) return 'week';
  return null;
}

/** Where a rate carries you if nothing changes, and what a few points is worth. The app
    is called Project 1%; this is the arithmetic behind the name. */
function project(rate, days, betterBy = 0.06) {
  if (rate == null || !days) return null;
  const betterRate = Math.min(1, rate + betterBy);
  const now = Math.round(rate * days), better = Math.round(betterRate * days);
  return { now, better, gain: better - now, rate, betterRate };
}

/** How well you know what you know. Bjork's fluency illusion in one number: of the
    cards you said you were sure about, how many you actually got right. Below ~0.8 and
    your sense of your own knowledge is the thing that needs fixing first. */
function calibration(cards) {
  let sure = 0, sureRight = 0, unsure = 0, unsureRight = 0;
  (cards || []).filter(c => !c.archived).forEach(c => {
    sure += c.sure || 0;
    sureRight += c.sureRight || 0;
    unsure += c.unsure || 0;
    unsureRight += c.unsureRight || 0;
  });
  return {
    sure, unsure,
    onSure: sure ? sureRight / sure : null,
    onUnsure: unsure ? unsureRight / unsure : null,
    // Overconfidence is the gap between feeling sure and being right.
    gap: sure >= 10 ? 1 - sureRight / sure : null,
  };
}

/** Deep versus shallow, over whatever carries the flag. Newport's distinction is
    argued rather than trialled, so this reports a ratio and never scores it. */
function deepShare(items, fromKey, toKey) {
  const inRange = (items || []).filter(x => {
    const d = x.date || x.completedAt || x.due;
    return d && d >= fromKey && d <= toKey;
  });
  if (!inRange.length) return null;
  const deep = inRange.filter(x => x.deep).length;
  return { deep, total: inRange.length, share: deep / inRange.length };
}

// ---------- companion ----------
// A coach, not a chatbot. It reads the same logs the grids draw and ranks what is
// worth saying right now. Rule-based on purpose: this app makes no network calls,
// so a hosted model would mean a server, an account and a subscription — the three
// things it exists to avoid. Every number below comes from your own history.

/** Completion over the last `days` calendar days ending at endKey, scheduled days only. */
function completionRate(habit, logValue, endKey, days) {
  const goal = goalOf(habit);
  let done = 0, total = 0;
  for (let i = 0; i < days; i++) {
    const key = addDays(endKey, -i);
    if (!isScheduled(habit, key)) continue;
    total++;
    if (fraction(logValue(habit.id, key), goal) >= 1) done++;
  }
  return { done, total, rate: total ? done / total : 0 };
}

/** Per-weekday hit rate — finds the day of the week a habit keeps dying on. */
function weekdayRates(habit, logValue, endKey, days = 84) {
  const goal = goalOf(habit);
  const hit = [0, 0, 0, 0, 0, 0, 0], seen = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < days; i++) {
    const key = addDays(endKey, -i);
    if (!isScheduled(habit, key)) continue;
    const w = weekdayOf(key);
    seen[w]++;
    if (fraction(logValue(habit.id, key), goal) >= 1) hit[w]++;
  }
  return seen.map((n, w) => ({ weekday: w, seen: n, done: hit[w], rate: n ? hit[w] / n : 0 }));
}

function daysBetween(fromKey, toKey) {
  // Round, don't floor: a DST changeover makes one of these days 23 or 25 hours long.
  return Math.round((fromYMD(toKey) - fromYMD(fromKey)) / 86400000);
}

const MILESTONES = [3, 7, 14, 21, 30, 50, 100, 200, 365];
function nextMilestone(count) { return MILESTONES.find(m => m > count) || null; }

/** How many consecutive wins from here to lift `done/total` to `goalRate`. */
function checkinsToReach(done, total, goalRate) {
  if (total && done / total >= goalRate) return 0;
  // The 1e-9 is not superstition: 0.8 * 30 is 24.000000000000004, and ceil() turns
  // that crumb into a whole extra day of work.
  return Math.max(1, Math.ceil((goalRate * total - done) / (1 - goalRate) - 1e-9));
}

const capFirst = s => s[0].toUpperCase() + s.slice(1);

/**
 * ctx: { habits, logValue, today, tasks, budget, spentMonth, money, hour }
 * Returns [{ id, icon, text, act, tone, weight }] sorted most urgent first.
 * `act` is a data-act string the UI hands straight to its click handler.
 */
function coach(ctx) {
  const t = ctx.today;
  const logValue = ctx.logValue;
  const money = ctx.money || (n => String(Math.round(n)));
  const tips = [];
  const add = (weight, id, icon, text, act, tone) =>
    tips.push({ id, icon, text, act: act || null, tone: tone || 'plain', weight });

  const live = (ctx.habits || []).filter(h => !h.archived);
  if (!live.length) {
    add(100, 'empty', '🌱', 'No habits yet. Start with one — the smallest one you would still do on your worst day.', 'hnew', 'good');
    return tips;
  }

  const dueToday = live.filter(h => isScheduled(h, t));
  const open = dueToday.filter(h => fraction(logValue(h.id, t), goalOf(h)) < 1);
  const doneToday = dueToday.length - open.length;

  // streak() treats an unfinished day as still open, which is right for today and wrong
  // for yesterday: a habit missed yesterday has already broken, so warning that its run
  // "ends tonight" is simply false. Both rules below hang off this one question.
  const missedYesterday = h => {
    const y = addDays(t, -1);
    return isScheduled(h, y) && fraction(logValue(h.id, y), goalOf(h)) < 1;
  };

  // A streak ending tonight outranks everything else: it is the only thing here that
  // cannot be recovered tomorrow.
  open.filter(h => !missedYesterday(h))
    .map(h => ({ h, s: streak(h, logValue, addDays(t, -1)) }))
    .filter(x => x.s >= 3)
    .sort((a, b) => b.s - a.s)
    .slice(0, 2)
    .forEach(x => add(90 + Math.min(x.s, 9), 'risk-' + x.h.id, '🔥',
      `${x.s} days of ${x.h.name} end tonight unless you check in.`, 'hopen:' + x.h.id, 'warn'));

  if (ctx.hour >= 20 && open.length && !doneToday)
    add(85, 'late', '🌙',
      `${open.length} habit${open.length > 1 ? 's' : ''} still open and the day is nearly gone. Do the easiest one now — a partial day beats a zero.`,
      'hopen:' + open[0].id, 'warn');

  if (dueToday.length && !open.length)
    add(80, 'perfect', '🎉', `Perfect day — all ${dueToday.length} done. Streaks are made of exactly this.`, null, 'good');
  else if (open.length === 1 && dueToday.length > 1)
    add(78, 'onemore', '🎯', `One left for a perfect day: ${open[0].name}.`, 'hopen:' + open[0].id, 'good');

  // Only for habits already checked in today: a milestone 'tomorrow' is a lie if
  // today is still open, and it would sit next to that habit's own at-risk warning.
  dueToday.filter(h => !open.includes(h)).forEach(h => {
    const s = streak(h, logValue, t);
    const next = nextMilestone(s);
    if (s > 0 && next && next - s === 1)
      add(70, 'mile-' + h.id, '🏅', `${h.name} reaches ${next} days tomorrow. Do not blink.`, 'hopen:' + h.id, 'good');
  });

  if (ctx.budget > 0) {
    const d = fromYMD(t);
    const dim = daysInMonth(d.getFullYear(), d.getMonth() + 1);
    const left = dim - d.getDate();
    const share = ctx.spentMonth / ctx.budget;
    const pace = d.getDate() / dim;
    if (share > 1)
      add(66, 'overbudget', '💸',
        `Over budget by ${money(ctx.spentMonth - ctx.budget)} with ${left} day${left === 1 ? '' : 's'} of the month left.`,
        'tab:fin', 'warn');
    else if (share - pace > 0.15 && left > 0)
      add(50, 'pace', '💸',
        `${Math.round(share * 100)}% of the budget spent ${Math.round(pace * 100)}% into the month. ${money((ctx.budget - ctx.spentMonth) / left)} a day keeps you inside it.`,
        'tab:fin', 'warn');
  }

  const late = (ctx.tasks || []).filter(x => !x.done && x.due && x.due < t);
  if (late.length)
    add(55, 'overdue', '⏰', late.length === 1
      ? `"${late[0].title}" is past due. Close it or move it — it costs you something every time you look at it.`
      : `${late.length} tasks are past due. Take the oldest one and finish it.`, 'tab:task', 'warn');

  // Fading: this week against the one before, both ending yesterday so a
  // half-finished today doesn't read as a collapse.
  live.forEach(h => {
    const now = completionRate(h, logValue, addDays(t, -1), 7);
    const prev = completionRate(h, logValue, addDays(t, -8), 7);
    if (now.total >= 3 && prev.total >= 3 && prev.rate - now.rate >= 0.3)
      add(60, 'fade-' + h.id, '📉',
        `${h.name} is fading — ${now.done}/${now.total} this week against ${prev.done}/${prev.total} before. Shrink the target instead of dropping the habit.`,
        'hedit:' + h.id, 'warn');
  });

  live.forEach(h => {
    const rates = weekdayRates(h, logValue, addDays(t, -1)).filter(x => x.seen >= 4);
    if (rates.length < 3) return;
    const worst = rates.reduce((a, b) => (b.rate < a.rate ? b : a));
    const best = rates.reduce((a, b) => (b.rate > a.rate ? b : a));
    if (best.rate - worst.rate >= 0.4 && worst.rate < 0.6)
      add(45, 'weekday-' + h.id, '📅',
        `${capFirst(WEEKDAYS[worst.weekday])}s are where ${h.name} breaks — ${worst.done} of ${worst.seen}. Attach it to something you already do that day.`,
        'hedit:' + h.id);
  });

  live.filter(h => h.created && daysBetween(h.created, t) <= 7).forEach(h => {
    const age = daysBetween(h.created, t) + 1;
    add(40, 'new-' + h.id, '🌱', `Day ${age} of ${h.name}. The first week is the whole negotiation.`, 'hopen:' + h.id, 'good');
  });

  // The path: where 30 days of history actually puts you, and the price of the next rung.
  let done = 0, total = 0;
  live.forEach(h => {
    const r = completionRate(h, logValue, addDays(t, -1), 30);
    done += r.done; total += r.total;
  });
  if (total >= 10) {
    const pct = Math.round((done / total) * 100);
    const goalRate = pct < 80 ? 0.8 : pct < 95 ? 0.95 : 1;
    if (goalRate === 1)
      add(35, 'consistency', '📈', `${pct}% over 30 days. Nothing left to fix — just don't stop.`, 'tab:habits', 'good');
    const pj = project(done / total, 90);
    if (pj && pj.gain >= 3)
      add(33, 'compound', '📊',
        `At ${pct}% you finish the next 90 days on ${pj.now} check-ins. At ${Math.round(pj.betterRate * 100)}% it is ${pj.better} — ${pj.gain} more, from six points. That is the whole idea behind the name.`,
        'tab:habits', 'good');
    else {
      const n = checkinsToReach(done, total, goalRate);
      add(35, 'consistency', '📈',
        `${pct}% consistency over 30 days. ${n} straight check-in${n === 1 ? '' : 's'} from here puts you at ${Math.round(goalRate * 100)}%.`,
        'tab:habits', 'good');
    }
  }

  if (!dueToday.length)
    add(30, 'rest', '😌', 'Nothing scheduled today. Rest is part of the schedule, not a gap in it.', null, 'good');

  // ---- goals, learning, practice ----
  const goals = (ctx.goals || []).filter(g => !g.archived);
  const cards = (ctx.cards || []).filter(c => !c.archived);

  const due = dueCards(cards, t);
  if (due.length)
    add(72, 'review', '🧠',
      `${due.length} card${due.length === 1 ? '' : 's'} due. Recalling beats re-reading by a distance, and it takes minutes.`,
      'study', 'warn');

  if (goals.length) {
    goals.forEach(g => {
      if (!live.some(h => h.goalId === g.id))
        add(58, 'nohabit-' + g.id, '🎯',
          `"${g.statement}" has no habit behind it. A goal with no daily behaviour is a wish with a deadline.`,
          'goal:' + g.id, 'warn');
      const p = ctx.goalDone ? goalPace(g, ctx.goalDone(g.id), t) : null;
      if (!p || p.pct >= 1) return;
      if (p.daysLeft <= 0)
        add(53, 'late-' + g.id, '⌛',
          `"${g.statement}" is past its date at ${Math.round(p.pct * 100)}%. Move the date or cut the target — a deadline you ignore teaches you to ignore deadlines.`,
          'goal:' + g.id, 'warn');
      else if (p.ahead < 0 && p.expected - p.pct * g.target >= g.target * 0.1)
        add(52, 'pace-' + g.id, '📐',
          `"${g.statement}" is behind pace: ${Math.round(p.pct * 100)}% done, ${p.remaining} ${g.unit || 'to go'} in ${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'}.`,
          'goal:' + g.id, 'warn');
    });
  } else if (live.length >= 2) {
    add(68, 'nogoals', '🧭',
      'You are tracking habits with nothing above them. Name one thing they are for and put a date on it.',
      'goalnew', 'warn');
  }

  // Habits that keep failing and have no trigger. "After X, I will Y" is the single
  // best-evidenced habit intervention there is, and it is one sentence long.
  live.forEach(h => {
    if (h.cue) return;
    const r = completionRate(h, logValue, addDays(t, -1), 14);
    if (r.total >= 5 && r.rate < 0.5)
      add(48, 'nocue-' + h.id, '🔗',
        `${h.name} is at ${Math.round(r.rate * 100)}% and has no trigger. Give it one: "after ___, I will ${String(h.name).toLowerCase()}".`,
        'hedit:' + h.id, 'warn');
  });

  const leech = cards.filter(c => (c.lapses || 0) >= 4);
  if (leech.length)
    add(44, 'leech', '🩹',
      `${leech.length} card${leech.length === 1 ? ' keeps' : 's keep'} coming back wrong. Rewrite ${leech.length === 1 ? 'it' : 'them'} smaller — the card is the problem, not your memory.`,
      'study', 'warn');

  const pt = practiceTrend(ctx.sessions, 6);
  if (pt && pt.count >= 4 && pt.difficulty != null && pt.difficulty <= 2)
    add(42, 'tooeasy', '🥱',
      `Your last ${pt.count} practice sessions all felt easy. Comfortable practice keeps you exactly where you are — pick something you currently fail at.`,
      'practice', 'warn');
  else if (pt && pt.count >= 3 && pt.withFocus === 0)
    add(41, 'nofocus', '🎚️',
      'Recent sessions had no named focus. "Practise piano" is time spent; "the left hand in bar 12" is practice.',
      'practice');

  // Sunday, and nothing reviewed in the last six days.
  if (weekdayOf(t) === 0 && (!ctx.lastReview || ctx.lastReview <= addDays(t, -6)))
    add(36, 'weekly', '🪞',
      'The week is done. Five minutes looking at what actually happened beats an hour planning what should.',
      'weekly', 'good');

  // ---- the rules that read your own patterns ----

  // Never miss twice. The one rule in Atomic Habits that decides whether a lapse stays
  // an accident, and it only fires while today can still be saved.
  open.filter(missedYesterday).slice(0, 2).forEach(h =>
    add(88, 'twice-' + h.id, '⚠️',
      `You missed ${h.name} yesterday. One miss is an accident — two is the new pattern. Even the two-minute version breaks it.`,
      'hopen:' + h.id, 'warn'));

  const key = keystone(live, logValue, addDays(t, -1), 60);
  if (key)
    add(47, 'keystone', '🗝️',
      `On days you keep ${key.habit.name} you keep ${Math.round(key.withIt * 100)}% of everything else, against ${Math.round(key.without * 100)}% on days you do not. Protect that one first.`,
      'hopen:' + key.habit.id, 'good');

  const fs = freshStart(t, ctx.birthday);
  if (fs) {
    const dropped = live.filter(h => {
      const r = completionRate(h, logValue, addDays(t, -1), 14);
      return r.total >= 4 && r.rate < 0.35;
    });
    const when = { week: 'A new week', month: 'A new month', year: 'A new year', birthday: 'Your birthday' }[fs];
    add(fs === 'week' ? 38 : 64, 'fresh', '🌅',
      dropped.length
        ? `${when}. The clean slate is a real effect, and this is the best moment you will get to restart ${dropped[0].name}.`
        : `${when}. Fresh starts genuinely raise the odds a change sticks — if something needs restarting, start it today.`,
      dropped.length ? 'hedit:' + dropped[0].id : 'tab:habits', 'good');
  }

  const qd = quadrants(ctx.tasks, t, 30);
  if (qd.total >= 6 && qd.share2 != null && qd.share2 < 0.2)
    add(43, 'quadrant', '🧱',
      `${qd.q1 + qd.q3} of your last ${qd.total} finished tasks were deadline-driven. Almost nothing important-but-not-urgent got done, and that is the quadrant the returns come from.`,
      'tab:task', 'warn');

  // WOOP: the wish and the outcome are already written. The obstacle is the half that
  // does the work, and the half everyone skips.
  goals.filter(g => !g.obstacle).slice(0, 1).forEach(g =>
    add(46, 'woop-' + g.id, '🧗',
      `"${g.statement}" has no obstacle written down. Picturing it going well is the part that backfires — name what will actually get in the way.`,
      'goal:' + g.id, 'warn'));

  const cal = calibration(cards);
  if (cal.gap != null && cal.gap >= 0.2)
    add(45, 'calibration', '🪞',
      `You were wrong on ${Math.round(cal.gap * 100)}% of the cards you felt sure about. Recognising an answer is not knowing it — trust the ones you had to work for.`,
      'study', 'warn');

  // Somebody with no habit at all in an area they said they cared about.
  if (ctx.areasWithGoals && ctx.areaSilent)
    ctx.areaSilent.slice(0, 1).forEach(a =>
      add(34, 'saw-' + a.area, '⚖️',
        `Nothing logged in ${a.area} for ${a.days} days, and you have a goal there. Balance is not a nice-to-have — the neglected one is usually what breaks the others.`,
        'tab:grow'));

  return tips.sort((a, b) => b.weight - a.weight);
}

// ---------- applications ----------
// Jobs and degree programs share one pipeline; the app relabels 'offer' as Admitted for
// a program. An application is "out" once it's applied or later, and closed at the end.
const APP_STAGES = ['saved', 'preparing', 'applied', 'interview', 'waitlist', 'offer', 'accepted', 'rejected', 'withdrawn'];
const APP_CLOSED = ['accepted', 'rejected', 'withdrawn'];
const APP_OUT = ['applied', 'interview', 'waitlist'];

/** What needs doing on one application today, most urgent first. Thresholds follow the
    usual advice: follow up after ~10 quiet days, ask recommenders 6 weeks out. */
function appAlerts(a, today, o) {
  o = Object.assign({ followUpDays: 10, soonDays: 14, recDays: 42 }, o);
  if (APP_CLOSED.includes(a.status)) return [];
  const out = [];
  const left = (a.docs || []).filter(d => !d.done);
  if (a.nextDate && a.nextDate <= today)
    out.push({ kind: 'next', due: a.nextDate, late: a.nextDate < today, text: a.next || 'Next step is due' });
  if (a.deadline && !APP_OUT.includes(a.status) && a.status !== 'offer') {
    const n = daysBetween(today, a.deadline);
    if (n < 0) out.push({ kind: 'missed', due: a.deadline, late: true, text: 'Deadline passed without a submission' });
    else {
      if (n <= o.soonDays) out.push({ kind: 'deadline', due: a.deadline, late: false,
        text: `Due ${n === 0 ? 'today' : `in ${n} day${n === 1 ? '' : 's'}`}${left.length ? ` · ${left.length} item${left.length === 1 ? '' : 's'} left` : ''}` });
      if (n <= o.recDays && left.some(d => /recommend|reference|referral/i.test(d.title)))
        out.push({ kind: 'recs', due: a.deadline, late: false, text: 'Ask your recommenders now: they need 4–6 weeks' });
    }
  }
  if (APP_OUT.includes(a.status) && !(a.nextDate && a.nextDate > today)) {
    const last = (a.log && a.log.length ? a.log[a.log.length - 1].d : null) || a.appliedOn || a.created;
    const quiet = last ? daysBetween(last, today) : 0;
    if (quiet >= o.followUpDays)
      out.push({ kind: 'follow', due: today, late: false, text: `No news for ${quiet} days: follow up` });
  }
  return out;
}

// ---------- adaptation ----------
// The plan re-fits itself to what actually happened. Pure: adapt() returns the changes
// and the app applies them, keeping each one (with its undo) in DB.memory.

/** Morning weights typed into a habit's notes, newest first. The first plausible number wins. */
function weightsFrom(hid, logOf, endKey, days) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(endKey, -i), l = logOf(hid, d);
    const m = l && /(\d{2,3}(?:\.\d+)?)/.exec(l.n || '');
    if (m && +m[1] >= 70 && +m[1] <= 500) out.push({ d, w: +m[1] });
  }
  return out;
}
const meanOf = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const shortDate = key => fromYMD(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** Progress a goal measures itself from the logs: done tasks, timer minutes, or the
    7-day average weight against a start. null when the goal has no `track`. */
function trackedDone(g, ctx) {
  const tr = g && g.track;
  if (!tr) return null;
  if (tr.tasks) return tr.tasks.filter(id => ctx.tasks.some(t => t.id === id && t.done)).length;
  if (tr.trades) return (ctx.trades || []).length;
  if (tr.weight) {
    const avg = meanOf(weightsFrom(tr.weight, ctx.logOf, ctx.today, 7).map(x => x.w));
    return avg == null ? 0 : Math.max(0, Math.round((avg - tr.start) * 10) / 10);
  }
  if (tr.habits) {
    let mins = 0;
    for (let d = g.created || ctx.today; d <= ctx.today; d = addDays(d, 1))
      tr.habits.forEach(x => { if (!x.dow || x.dow.includes(weekdayOf(d))) mins += ctx.logValue(x.id, d) || 0; });
    return Math.round(mins / (tr.div || 1));
  }
  return null;
}

// ---------- trading ----------
// Everything is in R: the result divided by what was risked. +2R made twice the risk;
// -1R is a clean stop-out. R makes trades of different sizes comparable.
function tradeR(side, entry, stop, exit) {
  const risk = side === 'short' ? stop - entry : entry - stop;
  if (!(risk > 0) || !isFinite(exit)) return null; // a stop on the wrong side is no stop
  const r = (side === 'short' ? entry - exit : exit - entry) / risk;
  return Math.round(r * 100) / 100;
}

function tradeStats(trades) {
  const ts = trades.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let sum = 0, peak = 0, dd = 0, wins = 0, kept = 0;
  ts.forEach(t => {
    const r = +t.r || 0;
    sum += r; if (r > 0) wins++; if (t.rules) kept++;
    peak = Math.max(peak, sum); dd = Math.max(dd, peak - sum);
  });
  const n = ts.length, r2 = x => Math.round(x * 100) / 100;
  return { n, winRate: n ? wins / n : null, expectancy: n ? r2(sum / n) : null,
           compliance: n ? kept / n : null, sumR: r2(sum), maxDD: r2(dd) };
}

// ---------- Gmail and Google Calendar ----------
// Pure: these turn mail metadata and calendar events into proposals. Nothing here applies
// a change; the app queues every proposal until you approve it.

const MAIL_STAGES = [
  ['rejected', /\b(unfortunately|regret to inform|not (be )?moving forward|no longer (being )?considered|not been selected|decided to (move|go) forward with other|pursue other candidates|will not be (moving|proceeding))\b/],
  ['offer', /\b(pleased to (offer|extend)|offer letter|extend (you )?an offer|offer of (employment|admission)|you('ve| have) been admitted|congratulations on your admission)\b/],
  ['interview', /\b(interview|hirevue|video assessment|online assessment|codesignal|hackerrank|superday|next step in (our|the) hiring process|your availability)\b/],
  ['applied', /\b(thank you for (your )?(application|applying)|thanks for applying|(received|receipt of) your (application|submission)|application (has been )?(received|submitted)|you('|’)re all set)\b/],
];
const mailStage = text => { const t = String(text).toLowerCase(); const m = MAIL_STAGES.find(([, re]) => re.test(t)); return m ? m[0] : null; };
const TRANSACTIONAL = /noreply|no-reply|careers|recruit|talent|\bhr\b|workday|greenhouse|lever|icims|taleo|modernhire|smartrecruiters|admissions?/i;
const MAIL_STOP = new Set(['the', 'of', 'and', 'for', 'at', 'college', 'university', 'institute', 'school', 'business', 'technology', 'inc', 'bank', 'group', 'program', 'programs']);
const mailWords = s => String(s || '').toLowerCase().match(/[a-z0-9]+/g) || [];
const mailHas = (text, w) => new RegExp('\\b' + w.replace(/[^a-z0-9]/g, '') + '\\b').test(text);

/** The organisation a mail is from: display name minus the HR mailWords, else the address. */
function mailOrg(from) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(from || '');
  const name = (m ? m[1] : '').replace(/\b(careers?|recruiting|recruitment|talent( acquisition)?|team|hr|invitation|from|notifications?)\b/gi, '').replace(/\s+/g, ' ').trim();
  if (name) return name;
  const addr = (m ? m[2] : from || '').trim(), [local, dom] = addr.split('@');
  if (local && !/noreply|no-reply|donotreply/i.test(local)) return local.toUpperCase().length <= 4 ? local.toUpperCase() : local;
  return (dom || '').split('.').slice(-2, -1)[0] || addr;
}
/** The role or program named in a mail, if it names one. */
function mailTitle(subject, snippet) {
  const t = `${subject || ''} ${snippet || ''}`.replace(/&#39;|’/g, "'");
  const a = /\b(?:for|in) (?:the |our )?(.{4,80}?) (?:position|role|program)\b/i.exec(t);
  if (a) return a[1].trim();
  const b = /\b(?:for|application to) (?:the |our )?([A-Z][^,.;:!?]{3,60}?)(?= and\b| at\b|[,.;!]|$)/.exec(t);
  return b ? b[1].trim() : (subject || '').slice(0, 80);
}

/** Proposals from mail metadata: [{ id, from, subject, snippet, date (YYYY-MM-DD) }]. */
function mailProposals(msgs, apps, tasks) {
  const out = [];
  msgs.forEach(msg => {
    const head = `${msg.from || ''} ${msg.subject || ''}`.toLowerCase();
    const text = `${head} ${msg.snippet || ''}`.toLowerCase();
    // Tasks that a confirmation email closes (the plan names the sender pattern).
    tasks.filter(t => !t.done && t.mail && new RegExp(t.mail, 'i').test(head)).forEach(t =>
      out.push({ ref: msg.id + '|' + t.id, src: 'gmail', d: msg.date, text: `Email “${msg.subject}”: mark “${t.title}” done?`,
        ops: [{ op: 'set', coll: 'tasks', id: t.id, set: { done: true, completedAt: msg.date } }] }));
    const stage = mailStage(text);
    if (!stage) return;
    // The application it belongs to: org mailWords in sender or subject, title mailWords break ties.
    let best = null, score = 0;
    apps.forEach(a => {
      const ow = mailWords(a.org).filter(w => w.length >= 2 && !MAIL_STOP.has(w));
      if (!ow.some(w => mailHas(head, w))) return;
      const s = 1 + mailWords(a.title).filter(w => w.length >= 4 && !MAIL_STOP.has(w) && mailHas(text, w)).length + (APP_CLOSED.includes(a.status) ? 0 : 0.5);
      if (s > score) { score = s; best = a; }
    });
    if (best) {
      if (best.noMail) return;
      const from = APP_STAGES.indexOf(best.status), to = APP_STAGES.indexOf(stage);
      const ok = stage === 'rejected' ? !APP_CLOSED.includes(best.status) : to > from && !APP_CLOSED.includes(best.status);
      if (!ok) return;
      const set = { status: stage, log: (best.log || []).concat({ d: msg.date, s: stage, src: 'email' }) };
      if (stage === 'applied' && !best.appliedOn) set.appliedOn = msg.date;
      if (stage === 'interview') Object.assign(set, { next: 'Answer the interview / assessment email', nextDate: msg.date });
      out.push({ ref: msg.id, src: 'gmail', d: msg.date, text: `Email from ${mailOrg(msg.from)}: “${msg.subject}”. Move ${best.org} · ${best.title} to ${stage}?`,
        ops: [{ op: 'set', coll: 'apps', id: best.id, set }] });
      return;
    }
    // Not tracked yet: offer to add it, but only from something that looks like a hiring system.
    if (stage === 'interview' && !TRANSACTIONAL.test(msg.from || '')) return;
    const school = /admission|universit|college|\.edu\b|graduate|\bmba\b|\bms\b/.test(text);
    const org = mailOrg(msg.from), title = mailTitle(msg.subject, msg.snippet);
    out.push({ ref: msg.id, src: 'gmail', d: msg.date, text: `Email from ${org}: “${msg.subject}”. Add “${org} · ${title}” to Applications as ${stage}?`,
      ops: [{ op: 'add', coll: 'apps', rec: { id: 'ga-' + msg.id, kind: school ? 'school' : 'job', org, title, status: stage,
        deadline: null, appliedOn: stage === 'applied' ? msg.date : null, link: '', contact: '', next: '', nextDate: null,
        notes: 'Added from Gmail.', goalId: null, created: msg.date, log: [{ d: msg.date, s: stage, src: 'email' }], docs: [] } }] });
  });
  return out;
}

/** An instant as wall-clock "YYYY-MM-DDTHH:MM" in a time zone. */
function localOf(dateTime, tz) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(dateTime)).forEach(x => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
const evStart = (ev, tz) => (ev.start && ev.start.date) || (ev.start && localOf(ev.start.dateTime, ev.start.timeZone || tz));

/** Plan events you moved or deleted in Google, against what the app last pushed. */
function gcalPulled(events, map, tz) {
  const out = [];
  events.forEach(ev => {
    const key = ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.p1id;
    const m = key && map[key];
    if (!m || m.eventId !== ev.id) return;
    if (ev.status === 'cancelled') { if (!m.gone) out.push({ key, kind: 'deleted' }); return; }
    const s = evStart(ev, tz);
    if (s && s !== m.start) out.push({ key, kind: 'moved', start: s });
  });
  return out;
}

/** What to insert, patch or delete so Google matches the plan. desired: [{ key, body, start }]. */
function gcalDiff(desired, map) {
  const sig = b => JSON.stringify([b.summary, b.description, b.start, b.end, b.recurrence || null]);
  const want = new Map(desired.map(d => [d.key, d]));
  const inserts = [], patches = [], deletes = [];
  desired.forEach(d => {
    const m = map[d.key];
    if (!m) inserts.push(d);
    else if (m.sig !== sig(d.body)) patches.push(Object.assign({ eventId: m.eventId }, d));
  });
  Object.keys(map).forEach(k => { if (!want.has(k) && !map[k].gone) deletes.push({ key: k, eventId: map[k].eventId }); });
  return { inserts, patches, deletes, sig };
}

/** Busy events that land on a timer habit (a study or deep block): [{ day, habitId, summary, ref }]. */
function gcalClashes(events, habits, fromKey, days, tz) {
  const out = [];
  const busy = events.filter(ev => ev.status !== 'cancelled' && ev.transparency !== 'transparent' && ev.start && ev.start.dateTime &&
    !(ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.p1src));
  for (let i = 0; i < days; i++) {
    const day = addDays(fromKey, i);
    habits.filter(h => !h.archived && h.at && h.kind === 'timer' && isScheduled(h, day)).forEach(h => {
      const a0 = minutesOf(h.at), a1 = a0 + (h.minutes || h.target || 30);
      busy.forEach(ev => {
        const s = localOf(ev.start.dateTime, tz), e = localOf(ev.end.dateTime, tz);
        if (s.slice(0, 10) !== day) return;
        const b0 = minutesOf(s.slice(11)), b1 = e.slice(0, 10) === day ? minutesOf(e.slice(11)) : 24 * 60;
        if (b0 < a1 && a0 < b1) out.push({ day, habitId: h.id, summary: ev.summary || 'Busy', ref: `${ev.id}|${h.id}|${day}` });
      });
    });
  }
  return out;
}

/** Every adjustment the plan should make today, as { coll, id, set, kind, text }. */
function adapt(ctx) {
  const t0 = ctx.today, out = [];
  const tasks = ctx.tasks, byId = new Map(tasks.map(t => [t.id, t]));
  const due = new Map(tasks.map(t => [t.id, t.due]));
  const why = new Map(), slipped = new Set();
  const because = (id, s) => why.set(id, (why.get(id) || new Set()).add(s));
  const movable = t => !t.done && t.due && !t.pinned && t.goalId;

  // 1. A goal task 3+ days overdue gets a new date instead of rotting in red. The slip is
  //    counted, so one that keeps slipping can be called out rather than quietly moved forever.
  tasks.forEach(t => {
    if (!movable(t) || daysBetween(t.due, t0) < 3) return;
    due.set(t.id, addDays(t0, 2)); slipped.add(t.id);
    because(t.id, `it was ${daysBetween(t.due, t0)} days overdue`);
  });
  // 2. Anything waiting on a task keeps its spacing behind it, so a chain moves together.
  //    Only ever later: finishing early leaves the rest of the plan where it was.
  for (let pass = 0; pass < tasks.length; pass++) {
    let moved = false;
    tasks.forEach(t => {
      if (!movable(t) || !t.after || t.gap == null) return;
      const p = byId.get(t.after);
      const anchor = p && (p.done ? (p.completedAt || t0) : due.get(p.id));
      if (!anchor) return;
      const want = addDays(anchor, t.gap);
      if (want > due.get(t.id)) {
        due.set(t.id, want); moved = true;
        because(t.id, p.done ? `“${p.title}” finished later than planned` : `“${p.title}” moved`);
      }
    });
    if (!moved) break;
  }
  // 3. A task never moves past its hard date (`by`); hitting it is said out loud.
  tasks.forEach(t => {
    let to = due.get(t.id);
    if (to === t.due) return;
    let squeezed = false;
    if (t.by && to > t.by) { to = t.by > t.due ? t.by : t.due; squeezed = true; }
    const set = {};
    if (to !== t.due) set.due = to;
    if (slipped.has(t.id)) set.slips = (t.slips || 0) + 1;
    if (!Object.keys(set).length) return;
    const n = set.slips || 0;
    out.push({ coll: 'tasks', id: t.id, set, kind: squeezed ? 'squeeze' : 'move',
      text: `Moved “${t.title}” to ${shortDate(to)}: ${[...why.get(t.id)].join('; ')}.` +
        (squeezed ? ` It can't go past ${shortDate(t.by)}, so the time before it is tighter now.` : '') +
        (n >= 2 ? ` That's ${n} slips: cut it smaller, or drop it.` : '') });
  });

  // 4. Habits with a ladder step up after two strong weeks and down after two weak ones.
  ctx.habits.forEach(h => {
    if (h.archived || !h.ladder || h.noAdapt) return;
    const start = h.since || h.created; // since: the day it reached this device
    if (start && daysBetween(start, t0) < 14) return;
    if (h.adaptedAt && daysBetween(h.adaptedAt, t0) < 14) return;
    const r = completionRate(h, ctx.logValue, addDays(t0, -1), 14); // today is still in progress
    if (r.total < 4) return;
    const steps = h.ladder.slice().sort((a, b) => a - b), cur = goalOf(h);
    const up = steps.find(s => s > cur), down = steps.filter(s => s < cur).pop();
    const unit = h.kind === 'timer' ? ' min' : '';
    let to = null, text = '';
    if (r.rate >= 0.9 && up != null) { to = up; text = `Raised “${h.name}” to ${up}${unit}: you kept it ${r.done} of ${r.total} days.`; }
    else if (r.rate <= 0.4 && down != null) { to = down; text = `Eased “${h.name}” to ${down}${unit}: ${r.done} of ${r.total} days kept. A target you hit beats one you skip.`; }
    if (to != null) out.push({ coll: 'habits', id: h.id, set: { target: to, adaptedAt: t0 }, kind: to > cur ? 'up' : 'down', text });
  });

  // 5. Calories follow the scale, at most every two weeks: under ~0.25 lb a week means
  //    eat more, over 1 lb a week means mostly fat, so eat less.
  ctx.goals.forEach(g => {
    const tr = g.track;
    if (g.archived || !tr || !tr.weight || g.kcal == null) return;
    if (g.kcalAt && daysBetween(g.kcalAt, t0) < 14) return;
    const ws = weightsFrom(tr.weight, ctx.logOf, t0, 14);
    const recent = ws.filter(x => daysBetween(x.d, t0) < 7).map(x => x.w);
    const prior = ws.filter(x => daysBetween(x.d, t0) >= 7).map(x => x.w);
    if (recent.length < 3 || prior.length < 3) return;
    const rate = Math.round((meanOf(recent) - meanOf(prior)) * 10) / 10;
    const step = rate < 0.25 ? 200 : rate > 1 ? -200 : 0;
    if (!step) return;
    out.push({ coll: 'goals', id: g.id, set: { kcal: g.kcal + step, kcalAt: t0 }, kind: 'kcal',
      text: `Calories ${step > 0 ? 'up' : 'down'} to ${g.kcal + step} a day: your weekly average moved ${rate} lb (aim for about 0.5).` });
  });

  // 6. Trading size is earned. Each block of 50 trades is judged on its own: a positive
  //    expectancy with 90%+ of rules kept unlocks the next risk step. A 6R drawdown inside
  //    the last 20 trades drops one step straight away.
  ctx.goals.forEach(g => {
    const tr = g.track;
    if (g.archived || !tr || !tr.trades || !g.riskLadder) return;
    const all = (ctx.trades || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const steps = g.riskLadder, i = Math.max(0, steps.indexOf(g.risk || 0));
    const from = g.riskN || 0, name = v => (v ? v + '% of the account' : 'paper only');
    const recent = tradeStats(all.slice(Math.max(from, all.length - 20)));
    if (i > 0 && recent.maxDD >= 6) {
      out.push({ coll: 'goals', id: g.id, kind: 'risk', set: { risk: steps[i - 1], riskN: all.length },
        text: `Risk per trade cut to ${name(steps[i - 1])}: a ${recent.maxDD}R drawdown in the last ${recent.n} trades. Earn it back over 50.` });
      return;
    }
    if (all.length - from < 50) return;
    const s = tradeStats(all.slice(from));
    const pass = s.expectancy > 0 && s.compliance >= 0.9;
    const to = pass && i < steps.length - 1 ? steps[i + 1] : steps[i];
    out.push({ coll: 'goals', id: g.id, kind: 'risk', set: { risk: to, riskN: all.length },
      text: `${s.n} trades: ${s.expectancy > 0 ? '+' : ''}${s.expectancy}R a trade, rules kept ${Math.round(s.compliance * 100)}%. ` +
        (to !== steps[i] ? `Earned the next size: ${name(to)}.`
          : pass ? `Already at the top step (${name(to)}).`
          : `Size stays at ${name(to)}. Fix one rule and run another 50.`) });
  });
  return out;
}

// BOXES is a const, so it never lands on window on its own. Attached by hand because
// the app reads it to show "box 3 of 7".
if (typeof window !== 'undefined') Object.assign(window, { BOXES, APP_STAGES, APP_CLOSED });

// Browser gets globals; Node gets exports. One line beats a build step.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ymd, fromYMD, todayKey, addDays, weekdayOf, daysInMonth, monthKey, startOfWeek,
    goalOf, fraction, isScheduled, streak, periodProgress,
    spend, income, balance, sameMonth,
    findDate, findTime, recurringWeekday, cleanTitle, parseText, parseICS, parseICSDate,
    completionRate, weekdayRates, daysBetween, nextMilestone, checkinsToReach, coach,
    dayIndex, indexSeries, minutesOf, hhmm, daySchedule,
    reviewCard, dueCards, retention, goalPace, practiceTrend, BOXES,
    keystone, quadrants, freshStart, project, calibration, deepShare,
    APP_STAGES, APP_CLOSED, appAlerts, weightsFrom, trackedDone, adapt, tradeR, tradeStats,
    mailStage, mailOrg, mailTitle, mailProposals, localOf, gcalPulled, gcalDiff, gcalClashes,
  };
}
