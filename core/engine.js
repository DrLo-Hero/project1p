'use strict';
// Goal-and-development layer. Owns the Personal Model, elicitation, goals, practices,
// sessions, alignment, load, replanning, development tracking, coaching, reviews and
// the decision queue. It consumes Signals (signals.js) and reaches calendars only
// through the provider contract (calendar.js). Rules only: no model calls of its own.
//
// Discipline that keeps undo and audit honest: stored records are only mutated inside
// _tx, through tx.edit / tx.put / tx.restore. Everything handed out is a clone.

(function (root) {
'use strict';
const isNode = typeof module === 'object' && !!module.exports;
const R = isNode ? require('../rules.js') : root;
const S = isNode ? require('./signals.js') : root.P1.signals;
// WebCrypto exists in both. Node 18 only exposes it through require('crypto').
const subtle = (root.crypto && root.crypto.subtle) || (isNode ? require('crypto').webcrypto.subtle : null); // null over plain-http LAN previews
// ponytail: browsers have no AsyncLocalStorage, so the nested-transaction guard is Node-only.
// test.js runs every path under Node, which is where a nested _tx would be caught.
const inTx = isNode ? new (require('async_hooks').AsyncLocalStorage)() : { getStore: () => undefined, run: (_, f) => f() };

const VERSION = 'engine-1';
const STATE_FORMAT = 'project1pct-state/1';
const MIN = 60e3, H = 60 * MIN, DAY = 24 * H;

/** Every threshold, with its default. Documented in app/core/README.md. */
const DEFAULTS = {
  autoCreate: 0.95,            // email confidence for Tier 1 (commit + undo + notify)
  approvalFloor: 0.70,         // below this: Tier 3, "possible item", no event proposal
  weeklyCapMinutes: 3000,      // overall weekly load cap if the model sets none
  nearCapRatio: 0.85,          // at or above: accept_with_caveat
  overCapWeeks: 2,             // N consecutive weeks over cap -> deload proposal
  recoveryGapHours: 48,        // between high-intensity blocks in one domain
  assessmentQuietHours: 12,    // nothing non-critical in the hours before an assessment/mock
  cascadeAutoMax: 2,           // replans touching more sessions than this interrupt you
  driftAdherence: 0.6,         // adherence below this over the window = drift
  driftWindowDays: 14,
  readinessFloor: 40,          // wearable readiness below this degrades high-intensity work
  missedAfterHours: 12,        // an unlogged session counts as missed after this
  undoGraceHours: 72,          // undo window; soft-deleted records purge after it
  rawRetentionDays: 30,        // raw email bodies, then metadata only
  reviewGraceDays: { daily: 1, weekly: 2, monthly: 5, quarterly: 14, annual: 30 },
  metaPromptAfter: 5,          // same-kind rejections before asking to change the default
  slotSearchDays: 14,          // how far ahead the engine looks for an alternative slot
  backoff: { baseMs: 60e3, maxMs: H },
};

class EngineError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

const clone = v => (v === undefined ? undefined : structuredClone(v));
const pct = x => `${Math.round(x * 100)}%`;
const pad = n => String(n).padStart(2, '0');
const num = id => +String(id).split('_').pop() || 0;
const overlaps = (a, b, pre = 0, post = 0) => a.start < b.end + post && a.end > b.start - pre;
const link = r => ({ kind: r.kind, id: r.id, title: r.title || r.text, ...(r.kind === 'goal' ? { version: r.version, status: r.status } : {}) });
const snapshot = g => { const { versions, ...rest } = g; return clone(rest); };
const fmtNum = v => (Math.abs(v) >= 100 ? Math.round(v) : +v.toFixed(2));

const PROTECTED = new Set(['identity', 'values', 'nonNegotiables', 'antiGoals']);
const STATUSES = ['draft', 'active', 'paused', 'achieved', 'abandoned', 'renegotiated'];
const PRACTICE_DOMAINS = ['physical', 'study', 'skill', 'reflection', 'recovery', 'relational'];
const LEARNING = new Set(['study', 'skill']);
const LEVELS = ['not_started', 'learning', 'practicing', 'proficient', 'mastered'];
const REVIEW_DOSE = { not_started: 3, learning: 3, practicing: 2, proficient: 1, mastered: 0.5 }; // retrieval sessions/week
const CRITICAL = new Set(['assessment', 'mock']);
const MARKER = new Set(['deadline', 'all_day']); // on the calendar, but not a block of time
const RECOVERY_GATES = new Set(['sleep_window', 'non_negotiable', 'recovery_gap']);
const URGENCY = { deadline: 1, assessment: 1, mock: 0.9, recovery: 0.6, practice: 0.5, event: 0.5, all_day: 0.3 };
const LOG_STATUS = ['done', 'minimum', 'skipped', 'missed'];
const PERIOD_DAYS = { daily: 1, weekly: 7, monthly: 30, quarterly: 91, annual: 365 };
const WINDOWS = { morning: { start: '06:00', end: '12:00' }, afternoon: { start: '12:00', end: '17:00' }, evening: { start: '17:00', end: '22:00' } };
const bucketOf = h => (h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening');
const DAYNAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Motivational-interviewing prompts: open questions, no advice, no suggestions.
const PROMPTS = {
  domains: 'Which parts of your life matter most to you right now — and which feel neglected?',
  values: 'When you are at your best, what are you protecting or honouring?',
  vision: 'Picture one of those areas going well a few years from now. What is different?',
  goals: 'Of what you described, what would you most want to be true in a year — in your own words?',
  antiGoals: 'What would you refuse to become, or give up, on the way there?',
  obstacles: 'What is most likely to get in the way — inside you or around you? And what do you already have going for you?',
  practices: 'What is the smallest version of this that would still count on a bad day?',
};
const REELICIT = [
  'Is this still yours — would you choose it today?',
  'Has it cost what you expected?',
  'Has the outcome you want changed?',
  'What have you learned that should change it?',
];
const REQUIRED = {
  daily: ['blocks', 'readiness', 'intention', 'prompt'],
  weekly: ['adherence', 'load', 'wins', 'misses', 'next_week', 'observation', 'question'],
  monthly: ['leading_trends', 'lagging_movement', 'mastery', 'goal_health', 'forecast', 'replans'],
  quarterly: ['goal_health', 'priority_rank', 'vision_check', 'anti_goal_check', 'sustainability', 'goal_decision', 're_elicitation'],
  annual: ['identity', 'values', 'evidence_log', 'anti_goal_reassessment', 'major_resets'],
};

function createEngine({ now = () => Date.now(), config = {}, secret } = {}) {
  if (!secret) throw new EngineError('invalid', 'createEngine needs a secret: it signs deletion reports');
  const cfg = { ...DEFAULTS, ...config, reviewGraceDays: { ...DEFAULTS.reviewGraceDays, ...(config.reviewGraceDays || {}) } };
  const tenants = new Map();
  const enc = s => new TextEncoder().encode(s);
  const key = use => subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [use]);
  const sign = async report => [...new Uint8Array(await subtle.sign('HMAC', await key('sign'), enc(JSON.stringify(report))))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return {
    cfg, VERSION,
    /** One tenant. Every lookup goes through its own map, so another user's id is just "not found". */
    user(id, init) {
      if (typeof id !== 'string' || !id) throw new EngineError('invalid', 'user id must be a non-empty string');
      if (!tenants.has(id)) tenants.set(id, new User(id, init, cfg, now));
      return tenants.get(id);
    },
    has: id => tenants.has(id),
    async deleteAccount(id) {
      const u = tenants.get(id);
      if (!u) throw new EngineError('not_found', 'no such account');
      let tokensRevoked = 0;
      for (const acc of u.accounts.values()) if (acc.adapter.revoke) { await acc.adapter.revoke(); tokensRevoked++; }
      const counts = {};
      for (const r of u.rec.values()) counts[r.kind] = (counts[r.kind] || 0) + 1;
      const report = {
        userId: id, deletedAt: now(), engineVersion: VERSION, counts, auditEntries: u.audit.length,
        rawBodiesRemoved: u.raw.size, cachedFreeBusyRemoved: [...u.accounts.values()].filter(a => a.cache).length,
        idempotencyKeysRemoved: u.idem.size, tokensRevoked,
      };
      await u.lock; // let in-flight writes land before wiping
      u.rec.clear(); u.raw.clear(); u.audit.length = 0; u.undos.clear(); u.idem.clear(); u.inflight.clear(); u.accounts.clear();
      tenants.delete(id);
      return { ...report, signature: await sign(report) };
    },
    /** subtle.verify compares in constant time. */
    async verifyReport(report) {
      const { signature, ...rest } = report || {};
      if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) return false;
      const sig = new Uint8Array(signature.match(/../g).map(h => parseInt(h, 16)));
      return subtle.verify('HMAC', await key('verify'), sig, enc(JSON.stringify(rest)));
    },
    /** Reloads a tenant from User.dump(). Calendars are the caller's: pass one adapter per saved calendar id. */
    restore(state, adapters = {}) {
      if (!state || state.format !== STATE_FORMAT) throw new EngineError('invalid', `not a ${STATE_FORMAT} snapshot`);
      if (tenants.has(state.id)) throw new EngineError('invalid', 'that user is already loaded');
      const st = clone(state), model = st.rec.find(r => r.id === 'model');
      const u = new User(st.id, { tz: model.tz }, cfg, now);
      Object.assign(u, { createdAt: st.createdAt, seq: st.seq, audit: st.audit, rec: new Map(st.rec.map(r => [r.id, r])), undos: new Map(st.undos), idem: new Map(st.idem), raw: new Map(st.raw) });
      for (const a of st.accounts) {
        if (!adapters[a.id]) throw new EngineError('invalid', `no adapter supplied for calendar "${a.id}"`);
        u.accounts.set(a.id, { ...a, adapter: adapters[a.id] });
      }
      tenants.set(st.id, u);
      return u;
    },
  };
}

class User {
  constructor(id, init = {}, cfg, now) {
    Object.assign(this, { id, cfg, now, createdAt: now(), rec: new Map(), seq: 0, audit: [], undos: new Map(), idem: new Map(), inflight: new Map(), raw: new Map(), accounts: new Map(), lock: Promise.resolve() });
    const m = clone(init) || {};
    this.rec.set('model', {
      id: 'model', kind: 'model', tz: 'UTC', identity: null, domains: [], values: [], nonNegotiables: [],
      antiGoals: [], preferences: {}, constraints: [], sleep: { start: '23:00', end: '07:00' },
      trustedDomains: [], optInSenders: [], ...m, caps: { total: cfg.weeklyCapMinutes, byDomain: {}, ...(m.caps || {}) },
    });
    this.rec.set('feedback', { id: 'feedback', kind: 'feedback', counts: {} });
    if (!S.isIANA(this.model.tz)) throw new EngineError('invalid', `time zone must be an IANA name, got "${this.model.tz}"`);
  }

  // ---------- records ----------

  get model() { return this.rec.get('model'); }
  get tz() { return this.model.tz; }
  _id(kind) { return `${kind}_${++this.seq}`; }
  get(id, kind) {
    const r = typeof id === 'string' ? this.rec.get(id) : undefined;
    // Same message whether it never existed or belongs to someone else: no oracle.
    if (!r || r.deletedAt || (kind && r.kind !== kind)) throw new EngineError('not_found', `no ${kind || 'record'} with that id`);
    return r;
  }
  find(id, kind) { try { return this.get(id, kind); } catch { return null; } }
  list(kind, pred = () => true) {
    const out = [];
    for (const r of this.rec.values()) if (r.kind === kind && !r.deletedAt && pred(r)) out.push(r);
    return out;
  }
  read(id) { return clone(this.get(id)); }

  /** Plain JSON for createEngine().restore(). Waits for in-flight writes so it never captures half a transaction. */
  async dump() {
    await this.lock;
    return clone({
      format: STATE_FORMAT, id: this.id, createdAt: this.createdAt, seq: this.seq, rec: [...this.rec.values()], audit: this.audit,
      undos: [...this.undos], idem: [...this.idem], raw: [...this.raw], accounts: [...this.accounts.values()].map(({ adapter, ...a }) => a),
    });
  }

  // ---------- transactions, audit, undo ----------

  // ponytail: one lock per tenant serialises every write. Per-record locks if one user's write volume ever matters.
  _tx(actor, rationale, fn, traceId) {
    if (inTx.getStore() === this) return Promise.reject(new EngineError('internal', 'nested transaction'));
    const run = this.lock.then(() => inTx.run(this, () => this._txRun(actor, rationale, fn, traceId)));
    this.lock = run.catch(() => {});
    return run;
  }

  async _txRun(actor, rationale, fn, traceId) {
    const tx = { actor, traceId: traceId || this._id('trace'), changes: new Map(), provider: [] };
    const snap = id => { if (!tx.changes.has(id)) tx.changes.set(id, clone(this.rec.get(id)) ?? null); };
    tx.put = rec => {
      rec.id = rec.id || this._id(rec.kind);
      snap(rec.id);
      rec.createdAt = rec.createdAt ?? this.now();
      rec.traceId = rec.traceId || tx.traceId;
      this.rec.set(rec.id, rec);
      return rec;
    };
    tx.edit = (id, kind) => { const r = this.get(id, kind); snap(id); r.updatedAt = this.now(); return r; };
    tx.restore = (id, before) => { snap(id); if (before) this.rec.set(id, before); else this.rec.delete(id); };
    tx.cal = async (calId, op, eventId, data, opts = {}) => {
      const a = this._account(calId).adapter;
      try {
        const before = eventId ? await a.get(eventId) : null;
        const after = op === 'create' ? await a.create(data)
          : op === 'update' ? await a.update(eventId, data, opts)
          : op === 'delete' ? await a.delete(eventId, opts)
          : await a.respond(eventId, data);
        tx.provider.push({ calId, op, eventId: eventId || after.id, before, after: clone(after) });
        return after;
      } catch (e) { e.calendarId = e.calendarId || calId; throw e; }
    };
    let result;
    try {
      result = await fn(tx);
    } catch (e) {
      for (const [id, before] of [...tx.changes].reverse()) { if (before) this.rec.set(id, before); else this.rec.delete(id); }
      for (const p of [...tx.provider].reverse()) await this._invert(p).catch(() => {});
      throw e;
    }
    if (!tx.changes.size && !tx.provider.length) return { result, undo: null, traceId: tx.traceId };
    const undo = this._id('undo'), at = this.now();
    const changes = [...tx.changes].map(([id, before]) => ({ id, before, after: clone(this.rec.get(id)) ?? null }));
    this.undos.set(undo, { at, actor, rationale, traceId: tx.traceId, changes, provider: tx.provider, undone: false });
    for (const c of changes) {
      const op = !c.before ? 'create' : !c.after || (c.after.deletedAt && !c.before.deletedAt) ? 'delete' : 'update';
      this.audit.push({ at, actor, op, kind: (c.after || c.before).kind, id: c.id, before: c.before, after: c.after, rationale, traceId: tx.traceId, undo });
    }
    for (const p of tx.provider) {
      this.audit.push({ at, actor, op: `calendar.${p.op}`, kind: 'calendar_event', id: p.eventId, calendarId: p.calId, before: p.before, after: p.after, rationale, traceId: tx.traceId, undo });
    }
    return { result, undo, traceId: tx.traceId };
  }

  async _invert(p) {
    const a = this._account(p.calId).adapter;
    const strip = e => { const { id, etag, ...rest } = e; return rest; };
    if (p.op === 'create') return a.delete(p.after.id);
    if (p.op === 'delete' && !p.after) return p.before ? a.create(strip(p.before)) : null;
    if (p.after && p.after.id !== p.eventId) await a.delete(p.after.id); // a "following" split made a new series
    return a.update(p.eventId, strip(p.before));
  }
  async _redo(p, remap) {
    const a = this._account(p.calId).adapter;
    const strip = e => { const { id, etag, ...rest } = e; return rest; };
    if (p.op === 'create') return a.create(strip(p.after));
    if (p.op === 'delete' && !p.after) return a.delete((remap[p.eventId] || {}).id || p.eventId);
    return a.update(p.eventId, strip(p.after));
  }

  /** Reverses one transaction: local records and calendar writes, all or nothing. */
  async undo(token) {
    const u = this.undos.get(token);
    if (!u) throw new EngineError('not_found', 'no such undo token');
    if (u.undone) return { status: 'already_undone' };
    if (this.now() - u.at > this.cfg.undoGraceHours * H) throw new EngineError('expired', `undo window of ${this.cfg.undoGraceHours}h has passed`);
    const done = [], remap = {}, etags = {};
    try {
      for (const p of [...u.provider].reverse()) {
        const r = await this._invert(p);
        done.push(p);
        if (p.op === 'delete' && !p.after && r) remap[p.eventId] = r;
        else if (r && r.etag) etags[p.eventId] = r.etag;
      }
    } catch (e) {
      for (const p of done.reverse()) await this._redo(p, remap).catch(() => {});
      throw new EngineError('undo_failed', `could not reverse a calendar write (${e.code || e.message}); nothing was changed`, { cause: e.code });
    }
    const res = await this._tx('user', `undo ${token}: ${u.rationale}`, tx => {
      for (const c of [...u.changes].reverse()) {
        const before = clone(c.before);
        if (before && before.calendarRefs) {
          before.calendarRefs = before.calendarRefs.map(r => (remap[r.eventId] ? { ...r, eventId: remap[r.eventId].id, etag: remap[r.eventId].etag } : etags[r.eventId] ? { ...r, etag: etags[r.eventId] } : r));
        }
        tx.restore(c.id, before);
      }
    }, u.traceId);
    u.undone = true;
    return { status: 'undone', undo: res.undo };
  }

  // ---------- the decision queue ----------

  _queue(tx, p) {
    const existing = p.dedupKey && this.list('proposal', q => q.status === 'pending' && q.dedupKey === p.dedupKey)[0];
    if (existing) {
      // Same thread, same event: one proposal, updated in place, with its history kept.
      const q = tx.edit(existing.id);
      q.history.push({ rev: q.rev, at: this.now(), type: q.type, rationale: q.rationale, confidence: q.confidence, payload: q.payload });
      Object.assign(q, { type: p.type, rationale: p.rationale, confidence: p.confidence, payload: p.payload, affected: p.affected || [], trace: p.trace || q.trace, rev: q.rev + 1 });
      if (p.signalId && !q.signalIds.includes(p.signalId)) q.signalIds.push(p.signalId);
      return q;
    }
    const { signalId, ...rest } = p;
    return tx.put({ kind: 'proposal', status: 'pending', trace: [], affected: [], evidence: [], rev: 1, history: [], ...rest, signalIds: signalId ? [signalId] : [] });
  }
  async _queueNow(p, actor = 'system') { return clone((await this._tx(actor, p.rationale, tx => this._queue(tx, p))).result); }

  queue() {
    return this.list('proposal', p => p.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt || num(a.id) - num(b.id))
      .map(p => clone({ id: p.id, type: p.type, rationale: p.rationale, confidence: p.confidence, trace: p.trace, affected: p.affected, payload: p.payload, rev: p.rev, createdAt: p.createdAt }));
  }

  /** approve | reject | defer one item. Each decision is its own undoable transaction. */
  async decide(id, action, { edits = {}, reason = '' } = {}) {
    const p = this.get(id, 'proposal');
    if (p.status !== 'pending' && p.status !== 'deferred') throw new EngineError('invalid', `this proposal is already ${p.status}`);
    if (!['approve', 'reject', 'defer'].includes(action)) throw new EngineError('invalid', 'action is approve, reject or defer');
    const { result, undo } = await this._tx('user', `${action} ${p.type}${reason ? `: ${reason}` : ''}`, async tx => {
      const q = tx.edit(id);
      q.status = { approve: 'approved', reject: 'rejected', defer: 'deferred' }[action];
      q.decidedAt = this.now();
      q.decisionReason = reason || null;
      if (Object.keys(edits).length) { q.edits = clone(edits); this._feedback(tx, q, 'edit', edits); }
      if (action === 'reject') { this._feedback(tx, q, 'reject'); return null; }
      return action === 'approve' ? this._apply(tx, q, edits) : null;
    }, p.traceId);
    return { status: 'ok', result: clone(result), undo };
  }

  async bulk(action, { minConfidence = 0, type } = {}) {
    const out = [];
    for (const p of this.queue().filter(p => (!type || p.type === type) && p.confidence >= minConfidence)) {
      try { out.push({ id: p.id, ...(await this.decide(p.id, action)) }); }
      catch (e) { out.push({ id: p.id, status: 'error', code: e.code, error: e.message }); }
    }
    return out;
  }

  _feedback(tx, q, kind, edits) {
    const it = q.payload && q.payload.item;
    const bucket = it && Number.isFinite(it.start) ? bucketOf(S.zoned(it.start, this.tz).h) : 'any';
    const dom = (q.payload && q.payload.alignment && q.payload.alignment.domainId) || 'unaligned';
    const key = `${kind}:${q.type}:${dom}:${bucket}`;
    const fb = tx.edit('feedback');
    fb.counts[key] = (fb.counts[key] || 0) + 1;
    if (kind === 'edit') {
      tx.put({ kind: 'signal', type: 'feedback', source: 'queue', authority: 'user', confidence: 1, timestamp: this.now(), idempotencyKey: `fb:${q.id}:${q.rev}`, subject: { proposalId: q.id }, payload: { edits: clone(edits) } });
    }
    if (kind === 'reject' && bucket !== 'any' && fb.counts[key] === this.cfg.metaPromptAfter) {
      this._queue(tx, {
        type: 'meta_prompt', dedupKey: `meta:${key}`, confidence: 1,
        rationale: `You have rejected ${fb.counts[key]} ${bucket} ${this._domainName(dom)} proposals. Stop proposing ${bucket}s for this by default?`,
        payload: { change: { avoid: { ...WINDOWS[bucket], domainId: dom } } },
      });
    }
  }

  async _apply(tx, q, edits) {
    const P = q.payload;
    switch (q.type) {
      case 'event_proposal':
      case 'possible_item': {
        if (q.type === 'possible_item' && !(Number.isFinite(edits.start) && edits.end > edits.start)) throw new EngineError('invalid', 'a low-confidence item needs a start and end from you before it can be scheduled');
        if (q.type === 'possible_item') q.payload = { ...P, item: { title: P.extraction.title, type: 'event', ...edits } };
        return this._commitEvent(tx, q, edits);
      }
      case 'blocked': {
        const at = Number.isFinite(edits.start) ? { start: edits.start, end: edits.end } : P.alternative;
        if (!at) throw new EngineError('refused', 'there is no valid alternative slot; pick a time');
        const item = { ...P.item, start: at.start, end: at.end };
        const a = await this.align(item);
        if (a.gates.length) throw new EngineError('refused', `still blocked: ${a.gates.map(g => g.detail).join('; ')}`, { gates: a.gates });
        return this._createSession(tx, item, { ackUnaligned: P.ackUnaligned, calendarId: item.calendarId });
      }
      case 'reschedule': return this._applyMove(tx, { sessionId: P.sessionId, after: { start: edits.start ?? P.to.start, end: edits.end ?? P.to.end }, extra: { extraction: P.extraction, icsSequence: P.extraction.sequence } }, `rescheduled by the organiser (${q.signalIds.length} email${q.signalIds.length > 1 ? 's' : ''})`);
      case 'cancel': {
        const s = this.get(P.sessionId, 'session');
        const scope = P.scope || edits.scope;
        if (s.rrule && !scope) throw new EngineError('needs_scope', 'this is a recurring series: choose scope "this", "following" or "series"', { instances: P.instances });
        if (s.calendarRefs.length > 1 && !edits.calendarScope) throw new EngineError('needs_scope', 'this event is on several calendars: choose calendarScope (a calendar id, or "all")');
        const refs = edits.calendarScope && edits.calendarScope !== 'all' ? s.calendarRefs.filter(r => r.calendarId === edits.calendarScope) : s.calendarRefs;
        return this._deleteSession(tx, s.id, { refs, scope: scope || 'series', instance: P.instance ?? edits.instance });
      }
      case 'replan_interrupt': {
        const moves = edits.moves || P.moves;
        for (const m of moves) if (m.after) await this._applyMove(tx, m, `approved replan: ${P.reason}`);
        return { moved: moves.filter(m => m.after).length };
      }
      case 'conflict': {
        if (!['local', 'remote'].includes(edits.keep)) throw new EngineError('invalid', 'choose which version to keep: edits.keep = "local" or "remote"');
        if (edits.keep === 'local') return this._applyMove(tx, { sessionId: P.sessionId, after: P.local }, 'conflict resolved: kept your version', { force: true });
        const s = tx.edit(P.sessionId);
        const ref = s.calendarRefs.find(r => r.calendarId === P.calendarId) || s.calendarRefs[0];
        s.history.push({ at: this.now(), from: { start: s.start, end: s.end }, to: { start: P.remote.start, end: P.remote.end }, reason: 'conflict resolved: kept the calendar version' });
        Object.assign(s, { start: P.remote.start, end: P.remote.end, minutes: Math.round((P.remote.end - P.remote.start) / MIN), dirty: false });
        if (ref) ref.etag = P.remote.etag;
        return s;
      }
      case 'model_change': { const m = tx.edit('model'); m[P.field] = clone(P.value); return { field: P.field }; }
      case 'goal_change': return this._reviseGoal(tx, P.goalId, P.patch, `approved proposal: ${q.rationale}`);
      case 'deload':
      case 'strategy':
      case 'goal_renegotiation': {
        const option = edits.option;
        if (!option || !(P.options || []).some(o => o.option === option)) throw new EngineError('invalid', `choose one option: ${(P.options || []).map(o => o.option).join(', ')}`);
        const o = P.options.find(x => x.option === option);
        if (option === 'deload') {
          for (const p of this.list('practice', p => p.target)) { const live = tx.edit(p.id); live.deload = { factor: 0.6, until: this.now() + 7 * DAY, targetBefore: clone(p.target) }; live.target = { ...p.target, minutes: Math.round(p.target.minutes * 0.6) }; }
        } else if (option === 'scope_reduction') {
          for (const p of this.practicesFor(o.goalId)) { const live = tx.edit(p.id); live.targetBeforeReduction = clone(p.target); live.target = { ...(p.target || {}), minutes: p.mvd.minutes }; }
        } else if (option === 'pause' || option === 'abandon') {
          this._reviseGoal(tx, o.goalId, { status: option === 'pause' ? 'paused' : 'abandoned' }, `${q.type}: ${o.text}`);
        }
        return { option };
      }
      case 'reentry': {
        const slot = Number.isFinite(edits.start) ? { start: edits.start, end: edits.start + P.minutes * MIN } : P.slot;
        if (!slot) throw new EngineError('invalid', 'pick a time for the re-entry session');
        const p = this.get(P.practiceId, 'practice');
        return this._createSession(tx, { title: `${p.title} (re-entry, minimum dose)`, practiceId: p.id, type: 'practice', intensity: 'low', start: slot.start, end: slot.end, reentry: true }, { calendarId: this._primaryCalendar() });
      }
      case 'why_prompt': {
        if (edits.reason) { const p = tx.edit(P.practiceId); p.missReasons.push({ at: this.now(), reason: edits.reason }); }
        return null;
      }
      case 'meta_prompt': {
        const m = tx.edit('model');
        m.preferences = { ...m.preferences, avoidWindows: [...(m.preferences.avoidWindows || []), P.change.avoid] };
        return null;
      }
      default: return null; // review_escalation and other acknowledgements
    }
  }

  // ---------- Personal Model ----------

  async setModel(field, value, { actor = 'user', rationale = '', evidence = [] } = {}) {
    if (!(field in this.model) || ['id', 'kind'].includes(field)) throw new EngineError('invalid', `unknown model field "${field}"`);
    if (field === 'tz' && !S.isIANA(value)) throw new EngineError('invalid', `time zone must be an IANA name, got "${value}"`);
    if (actor !== 'user') {
      // Values, non-negotiables, anti-goals and identity are yours. The engine may only ask.
      if (PROTECTED.has(field)) {
        return { status: 'proposed', proposal: await this._queueNow({ type: 'model_change', rationale: rationale || `Proposed change to your ${field}. Only you can make it.`, confidence: 0.5, evidence, payload: { field, value: clone(value) } }) };
      }
      if (!evidence.length) throw new EngineError('invalid', 'an inferred change to the model must cite its evidence');
    }
    const { undo } = await this._tx(actor, rationale || `set ${field}`, tx => { tx.edit('model')[field] = clone(value); });
    return { status: 'applied', undo };
  }

  modelHistory() { return clone(this.audit.filter(a => a.id === 'model')); }

  /** "What the system believes about me": stated, inferred, and still-open questions. */
  beliefs() {
    const m = this.model;
    const goals = this.list('goal');
    const open = [];
    for (const p of this.list('pattern', p => p.status === 'open')) open.push({ ref: p.id, kind: 'inference', question: p.text, evidence: clone(p.evidence) });
    for (const g of goals.filter(g => !['abandoned', 'achieved'].includes(g.status))) {
      const t = g.tests || {};
      if (!t.origin) open.push({ ref: g.id, kind: 'goal_test', question: `Is "${g.title}" self-chosen, or borrowed from someone else?` });
      if (!t.substitution) open.push({ ref: g.id, kind: 'goal_test', question: `What stops, to make room for "${g.title}"?` });
      if (t.expectedMinutesPerWeek == null) open.push({ ref: g.id, kind: 'goal_test', question: `Roughly how many minutes a week do you expect "${g.title}" to cost?` });
    }
    for (const r of this.list('review', r => r.status === 'draft')) for (const i of r.items.filter(i => i.kind === 'question' && !i.decision)) open.push({ ref: r.id, kind: 'review_question', question: i.text });
    return clone({
      stated: {
        identity: m.identity, domains: m.domains, values: m.values, nonNegotiables: m.nonNegotiables,
        antiGoals: m.antiGoals, preferences: m.preferences, constraints: m.constraints, sleep: m.sleep, caps: m.caps,
        goals: goals.map(g => ({ id: g.id, title: g.title, status: g.status, version: g.version, lastReviewed: g.lastReviewed, authoredBy: g.authoredBy })),
      },
      inferred: this.list('pattern', p => p.status !== 'rejected').map(p => ({ id: p.id, label: 'inference', text: p.text, status: p.status, value: p.value ?? null, evidence: p.evidence })),
      openQuestions: open,
    });
  }

  /** One-tap correction of an inference; propagates into preferences the scheduler reads. */
  async correctBelief(id, { reject = false, value } = {}) {
    const { undo } = await this._tx('user', 'corrected an inference', tx => {
      const p = tx.edit(id, 'pattern');
      if (reject) { p.status = 'rejected'; return; }
      p.status = value !== undefined ? 'corrected' : 'confirmed';
      p.value = value !== undefined ? clone(value) : clone(p.suggested ?? null);
      if (p.appliesTo && p.value != null) { const m = tx.edit('model'); m.preferences = { ...m.preferences, [p.appliesTo]: clone(p.value) }; }
    });
    return { status: 'ok', undo };
  }

  // ---------- elicitation (Ch.1) ----------

  elicitation() {
    const m = this.model, goals = this.list('goal', g => g.authoredBy === 'user');
    const steps = {
      domains: m.domains.length > 0,
      values: m.values.length > 0,
      vision: this.list('vision').length > 0,
      goals: goals.length > 0,
      antiGoals: m.antiGoals.length > 0 || goals.some(g => g.antiGoals.length),
      obstacles: goals.some(g => g.obstacles.length),
      practices: this.list('practice').length > 0,
    };
    const next = Object.keys(steps).find(k => !steps[k]) || null;
    const phase = !steps.domains ? 'engaging' : !steps.vision ? 'focusing' : !steps.goals ? 'evoking' : !steps.practices ? 'planning' : 'concluding';
    return { steps, next, phase, prompt: next ? PROMPTS[next] : null };
  }

  /** Depth follows motivation: ambivalence and low readiness get evoking, not planning. */
  elicitationPrompt(goalId) {
    const g = this.get(goalId, 'goal'), mo = g.motivation || {};
    if (mo.ambivalent || mo.readiness < 5) return { phase: 'evoking', prompt: `What makes "${g.title}" matter to you — and what makes you hesitate?` };
    if (mo.confidence < 5) return { phase: 'evoking', prompt: `What would make you more confident you could do "${g.title}"?` };
    return { phase: 'planning', prompt: PROMPTS.practices };
  }

  /** Hypotheses only, and only after steps 1–4 are the user's own. */
  suggestGoals() {
    const e = this.elicitation();
    const missing = ['domains', 'values', 'vision', 'goals'].filter(k => !e.steps[k]);
    if (missing.length) throw new EngineError('elicitation_incomplete', `No suggestions yet: first describe your ${missing.join(', ')} in your own words.`, { missing, prompt: PROMPTS[missing[0]] });
    const out = [];
    for (const v of this.list('vision')) {
      if (this.list('goal', g => g.visionId === v.id).length) continue;
      out.push({ kind: 'hypothesis', visionId: v.id, text: `Hypothesis: your ${this._domainName(v.domainId)} vision ("${v.text}") has no goal under it yet. Is there one outcome there you would want? Accept, reject, or rewrite it.`, evidence: { visionId: v.id }, actions: ['accept', 'reject', 'rewrite'] });
    }
    for (const p of this.list('pattern', p => p.status === 'open')) out.push({ kind: 'hypothesis', text: p.text, evidence: clone(p.evidence), actions: ['accept', 'reject', 'rewrite'] });
    return out;
  }

  // ---------- visions, goals, milestones, practices ----------

  async _create(rec, rationale) { return clone((await this._tx('user', rationale || `created ${rec.kind}`, tx => tx.put(clone(rec)))).result); }

  async createVision(f) {
    if (!this.model.domains.some(d => d.id === f.domainId)) throw new EngineError('invalid', 'a vision belongs to one of your domains');
    if (!f.text) throw new EngineError('invalid', 'a vision needs your words');
    return this._create({ kind: 'vision', ...f });
  }

  async createGoal(f, { rationale = 'authored by you' } = {}) {
    if (f.status && f.status !== 'draft') throw new EngineError('invalid', 'a goal starts as a draft; activate it with setGoalStatus once it is well-formed');
    if (!f.title) throw new EngineError('invalid', 'a goal needs a title');
    if (f.domainId && !this.model.domains.some(d => d.id === f.domainId)) throw new EngineError('invalid', 'unknown domain');
    if (f.visionId) this.get(f.visionId, 'vision');
    if (f.parentId) this.get(f.parentId, 'goal');
    return clone((await this._tx('user', rationale, tx => {
      const g = tx.put({ kind: 'goal', horizon: 'near', priority: 2, leading: [], lagging: [], antiGoals: [], obstacles: [], resources: [], motivation: {}, tests: {}, ...clone(f), status: 'draft', version: 1, authoredBy: 'user', lastReviewed: this.now() });
      g.versions = [{ v: 1, at: this.now(), rationale, snapshot: snapshot(g) }];
      return g;
    })).result);
  }

  async updateGoal(id, patch, { rationale, actor = 'user' } = {}) {
    this.get(id, 'goal');
    if (actor !== 'user') {
      return { status: 'proposed', proposal: await this._queueNow({ type: 'goal_change', rationale: rationale || 'proposed goal change', confidence: 0.5, trace: this.trace({ goalId: id }).chain, payload: { goalId: id, patch: clone(patch) } }) };
    }
    if (!rationale) throw new EngineError('invalid', "every goal change needs a rationale — it is kept in the goal's history");
    if (['status', 'version', 'versions', 'authoredBy'].some(k => k in patch)) throw new EngineError('invalid', 'status changes go through setGoalStatus');
    const { undo } = await this._tx('user', rationale, tx => this._reviseGoal(tx, id, patch, rationale));
    return { status: 'applied', goal: clone(this.get(id)), undo };
  }

  _reviseGoal(tx, id, patch, rationale) {
    const g = tx.edit(id, 'goal');
    Object.assign(g, clone(patch));
    let why = rationale;
    if (g.status === 'active') {
      const miss = this.wellFormed(g);
      if (miss.length) { g.status = 'draft'; why += ` — back to draft, now missing: ${miss.join('; ')}`; }
    }
    g.version++;
    g.lastReviewed = this.now();
    g.versions.push({ v: g.version, at: this.now(), rationale: why, snapshot: snapshot(g) });
    return g;
  }

  async setGoalStatus(id, status, { rationale, confirmAmbivalence = false } = {}) {
    if (!STATUSES.includes(status)) throw new EngineError('invalid', `status is one of ${STATUSES.join(', ')}`);
    if (!rationale) throw new EngineError('invalid', 'a status change needs a rationale');
    const g = this.get(id, 'goal');
    if (status === 'active') {
      const miss = this.wellFormed(g);
      if (miss.length) throw new EngineError('not_well_formed', `"${g.title}" stays a draft. Missing: ${miss.join('; ')}`, { missing: miss });
      if (g.motivation.ambivalent && !confirmAmbivalence) throw new EngineError('ambivalent', `You said you are in two minds about "${g.title}". Activating it needs you to say so explicitly (confirmAmbivalence).`);
    }
    const { undo } = await this._tx('user', rationale, tx => this._reviseGoal(tx, id, { status }, rationale));
    return { status: 'applied', goal: clone(this.get(id)), undo };
  }

  wellFormed(goalOrId) {
    const g = typeof goalOrId === 'string' ? this.get(goalOrId, 'goal') : goalOrId;
    const miss = [];
    if (!g.outcome) miss.push('an observable outcome');
    if (!g.leading.length || !g.lagging.length) miss.push('at least one leading and one lagging indicator');
    if (!g.targetDate) miss.push('a target date');
    if (!g.antiGoals.length) miss.push('a named anti-goal');
    const dosed = this.practicesFor(g.id).filter(p => !p.anti && p.mvd && p.mvd.minutes > 0);
    if (!dosed.length) miss.push('a practice with a minimum viable dose');
    for (const p of dosed.filter(p => LEARNING.has(p.domain))) {
      const gaps = this.learningGaps(p);
      if (gaps.length) miss.push(`"${p.title}" needs ${gaps.join(', ')}`);
    }
    if (!g.releaseCondition) miss.push('a release condition');
    return miss;
  }

  learningGaps(p) {
    const gaps = [];
    if (!(p.target && p.target.minutes > 0 && p.target.perWeek > 0)) gaps.push('a target dose');
    if (!(p.spacing && p.spacing.minGapDays >= 1)) gaps.push('spacing (at least a day between sessions, never massed)');
    if (!(p.masteryGate && p.masteryGate.criterion)) gaps.push('a mastery gate');
    if (!(p.retrieval && Array.isArray(p.retrieval.scheduleDays) && p.retrieval.scheduleDays.length)) gaps.push('a retrieval schedule');
    return gaps;
  }

  practicesFor(goalId) {
    const ms = new Set(this.list('milestone', m => m.goalId === goalId).map(m => m.id));
    return this.list('practice', p => (p.goalIds || []).includes(goalId) || ms.has(p.milestoneId));
  }

  async createMilestone(f) {
    this.get(f.goalId, 'goal');
    if (!f.title || !f.due || !f.measure) throw new EngineError('invalid', 'a milestone is dated and measurable: title, due and measure');
    return this._create({ kind: 'milestone', done: false, critical: false, ...f });
  }
  async completeMilestone(id, evidence) {
    if (!evidence) throw new EngineError('invalid', 'completing a milestone needs evidence');
    const { undo } = await this._tx('user', 'milestone reached', tx => { const m = tx.edit(id, 'milestone'); m.done = true; m.doneAt = this.now(); m.evidence = clone(evidence); });
    return { status: 'ok', undo };
  }

  async createPractice(f) {
    if (!PRACTICE_DOMAINS.includes(f.domain)) throw new EngineError('invalid', `practice domain is one of ${PRACTICE_DOMAINS.join(', ')}`);
    for (const g of f.goalIds || []) this.get(g, 'goal');
    if (f.milestoneId) this.get(f.milestoneId, 'milestone');
    if (!f.title) throw new EngineError('invalid', 'a practice needs a title');
    if (!f.anti && !(f.mvd && f.mvd.minutes > 0)) throw new EngineError('invalid', 'a practice needs a minimum viable dose (mvd.minutes): the smallest version that still counts');
    return this._create({ kind: 'practice', goalIds: [], mastery: 'not_started', masteryLog: [], missReasons: [], reviewPerWeek: LEARNING.has(f.domain) ? REVIEW_DOSE.not_started : null, ...f });
  }
  async updatePractice(id, patch, { rationale } = {}) {
    if (!rationale) throw new EngineError('invalid', 'a practice change needs a rationale');
    const { undo } = await this._tx('user', rationale, tx => Object.assign(tx.edit(id, 'practice'), clone(patch)));
    return { status: 'applied', undo };
  }

  // ---------- goal testing (Ch.4) ----------

  goalCost(goalId) {
    const since = this.now() - 28 * DAY;
    const minutes = this.list('session', s => s.goalId === goalId && s.start >= since && !['skipped', 'missed'].includes(s.status)).reduce((t, s) => t + (s.actualMinutes ?? s.minutes), 0);
    return { minutesPerWeek: Math.round(minutes / 4), window: '28 days' };
  }

  goalTests(id) {
    const g = this.get(id, 'goal'), t = g.tests || {}, out = [];
    if (t.origin === 'borrowed') out.push({ test: 'origin', detail: `you said this goal is borrowed${t.originFrom ? ` (from ${t.originFrom})` : ''}` });
    for (const need of ['autonomy', 'competence', 'relatedness']) if ((t.needs || {})[need] === 'undermines') out.push({ test: 'need', detail: `you said it undermines your ${need}` });
    const cost = this.goalCost(id).minutesPerWeek;
    if (t.expectedMinutesPerWeek > 0 && cost > 1.5 * t.expectedMinutesPerWeek) out.push({ test: 'bias', detail: `you expected about ${t.expectedMinutesPerWeek} min/week; over the last 4 weeks it has taken ${cost}` });
    if (t.wholeLife === 'unacceptable') out.push({ test: 'whole_life', detail: 'you said its cost to the rest of your life is not acceptable' });
    if (g.status === 'active' && !t.substitution) out.push({ test: 'substitution', detail: 'nothing is named that stops to make room for it' });
    if (!g.releaseCondition) out.push({ test: 'reversibility', detail: 'no evidence is named that would justify pausing or releasing it' });
    return out;
  }

  // ---------- traceability ----------

  trace(ref) {
    let practice = null;
    const chain = [];
    if (typeof ref !== 'string' && !(ref && (ref.practiceId || ref.goalId))) throw new EngineError('not_found', 'no record with that id');
    if (typeof ref === 'string') {
      const r = this.get(ref);
      if (r.kind === 'goal') return this._goalChain(r, chain);
      if (r.kind === 'practice') practice = r;
      if (r.kind === 'session') {
        chain.push(link(r));
        practice = r.practiceId ? this.find(r.practiceId, 'practice') : null;
        if (!practice) return this._goalChain(r.goalId ? this.find(r.goalId, 'goal') : null, chain);
      }
    } else if (ref && ref.practiceId) practice = this.find(ref.practiceId, 'practice');
    else if (ref && ref.goalId) return this._goalChain(this.find(ref.goalId, 'goal'), chain);
    if (!practice) return { chain, aligned: false, missing: 'practice or goal' };
    chain.push(link(practice));
    const ms = practice.milestoneId ? this.find(practice.milestoneId, 'milestone') : null;
    if (ms) chain.push(link(ms));
    return this._goalChain(this.find(ms ? ms.goalId : (practice.goalIds || [])[0], 'goal'), chain);
  }

  _goalChain(goal, chain) {
    if (!goal) return { chain, aligned: false, missing: 'goal' };
    const seen = new Set();
    let g = goal, vision = null;
    while (g && !seen.has(g.id)) {
      seen.add(g.id);
      chain.push(link(g));
      if (g.visionId) { vision = this.find(g.visionId, 'vision'); break; }
      g = g.parentId ? this.find(g.parentId, 'goal') : null;
    }
    const domainId = goal.domainId || (vision && vision.domainId) || null;
    if (!vision) return { chain, aligned: false, missing: 'vision', goalId: goal.id, domainId };
    chain.push(link(vision));
    const inactive = ['paused', 'abandoned', 'achieved', 'renegotiated'].includes(goal.status);
    return { chain, aligned: !inactive, missing: inactive ? `goal is ${goal.status}` : null, exploratory: goal.status === 'draft', goalId: goal.id, domainId };
  }

  goalGraph(goalId) {
    const goal = this.get(goalId, 'goal');
    const practices = this.practicesFor(goalId);
    const pids = new Set(practices.map(p => p.id));
    const sessions = this.list('session', s => s.goalId === goalId || pids.has(s.practiceId));
    const sids = new Set(sessions.map(s => s.id));
    const signals = this.list('signal', s => s.subject.goalId === goalId || sids.has(s.subject.sessionId) || pids.has(s.subject.practiceId));
    return clone({
      goal, children: this.list('goal', g => g.parentId === goalId), milestones: this.list('milestone', m => m.goalId === goalId),
      practices, sessions, signals,
    });
  }

  // ---------- time, load, free/busy ----------

  _domainName(id) { const d = this.model.domains.find(x => x.id === id); return d ? d.name : id; }
  _windowsAround(start, end, w) {
    const out = [];
    for (let k = R.addDays(S.dayKey(start, this.tz), -1); k <= S.dayKey(end, this.tz); k = R.addDays(k, 1)) {
      if (w.weekdays && !w.weekdays.includes(R.weekdayOf(k))) continue;
      out.push({ start: S.atLocal(k, w.start, this.tz), end: S.atLocal(w.end > w.start ? k : R.addDays(k, 1), w.end, this.tz) });
    }
    return out;
  }
  _overlapsDaily(start, end, w) { return !!(w && w.start && w.end) && this._windowsAround(start, end, w).some(x => start < x.end && end > x.start); }
  _withinDaily(start, end, w) { return this._windowsAround(start, end, w).some(x => start >= x.start && end <= x.end); }

  weekOf(ms) {
    const k = S.dayKey(ms, this.tz);
    const mon = R.addDays(k, -((R.weekdayOf(k) + 6) % 7));
    return { key: mon, from: S.atLocal(mon, '00:00', this.tz), to: S.atLocal(R.addDays(mon, 7), '00:00', this.tz) };
  }

  _instances(s, from, to) {
    if (s.rrule) return S.expand({ start: s.start, end: s.end, tz: this.tz, rrule: s.rrule, exdates: s.exdates || [] }, { from, to });
    return s.start < to && s.end > from ? [{ start: s.start, end: s.end }] : [];
  }

  loadForWeek(ms, excludeId) {
    const w = this.weekOf(ms), out = { week: w.key, total: 0, byDomain: {} };
    for (const s of this.list('session', s => s.id !== excludeId && !MARKER.has(s.type) && !['skipped', 'missed', 'cancelled'].includes(s.status))) {
      for (const i of this._instances(s, w.from, w.to)) {
        if (i.start < w.from) continue;
        const min = s.status === 'planned' ? Math.round((i.end - i.start) / MIN) : (s.actualMinutes ?? s.minutes);
        out.total += min;
        out.byDomain[s.domainId] = (out.byDomain[s.domainId] || 0) + min;
      }
    }
    return out;
  }
  _overCaps(load) {
    const caps = this.model.caps, over = [];
    if (caps.total && load.total > caps.total) over.push(`total ${load.total}/${caps.total} min`);
    for (const [d, cap] of Object.entries(caps.byDomain || {})) if ((load.byDomain[d] || 0) > cap) over.push(`${this._domainName(d)} ${load.byDomain[d]}/${cap} min`);
    return over;
  }

  _account(calId) { const a = this.accounts.get(calId); if (!a) throw new EngineError('not_found', 'no calendar with that id'); return a; }
  connectCalendar(id, adapter, { essential = true, primary = false } = {}) {
    this.accounts.set(id, { id, adapter, essential, primary, cache: null, health: { lastSyncAt: null, lastError: null, staleSince: null, failures: 0, nextRetryAt: null } });
  }
  _primaryCalendar() {
    const accs = [...this.accounts.values()].filter(a => !a.adapter.readOnly);
    return (accs.find(a => a.primary) || accs[0] || {}).id || null;
  }
  _healthy(acc) { acc.health = { ...acc.health, lastSyncAt: this.now(), lastError: null, staleSince: null, failures: 0, nextRetryAt: null }; }
  _unhealthy(acc, e) {
    const failures = acc.health.failures + 1, b = this.cfg.backoff;
    acc.health = { ...acc.health, lastError: `${e.code}: ${e.message}`, staleSince: acc.health.staleSince ?? this.now(), failures, nextRetryAt: this.now() + Math.min(b.baseMs * 2 ** (failures - 1), b.maxMs) };
  }
  accountHealth() {
    return [...this.accounts.values()].map(a => ({ id: a.id, essential: a.essential, readOnly: !!a.adapter.readOnly, ...clone(a.health), stale: a.health.staleSince != null }));
  }

  /** Every calendar merged with local sessions. An unreachable calendar serves its cache, marked stale. */
  async freeBusy(from, to, excludeId) {
    const blocks = [], stale = [], mine = new Set();
    for (const s of this.list('session')) {
      for (const r of s.calendarRefs) mine.add(r.eventId);
      if (s.id === excludeId || s.status !== 'planned' || MARKER.has(s.type)) continue;
      for (const i of this._instances(s, from, to)) {
        blocks.push({ start: i.start, end: i.end, status: s.tentative ? 'tentative' : 'busy', type: 'default', sessionId: s.id, title: s.title, location: s.location || null, priority: this._weight(s) });
      }
    }
    for (const acc of this.accounts.values()) {
      let list;
      try { list = await acc.adapter.freeBusy({ from, to }); acc.cache = { list, at: this.now() }; this._healthy(acc); }
      catch (e) { if (!e.code) throw e; this._unhealthy(acc, e); stale.push(acc.id); list = acc.cache ? acc.cache.list : []; }
      for (const b of list) if (!mine.has(b.eventId) && b.end > from && b.start < to) blocks.push({ ...b, calendarId: acc.id });
    }
    return { blocks, stale };
  }

  _weight(s) {
    const g = s.goalId && this.find(s.goalId, 'goal');
    if (!g) return 0;
    return g.status === 'active' ? ({ 1: 1, 2: 0.7, 3: 0.4 }[g.priority] ?? 0.4) : 0.2;
  }

  // ---------- alignment engine ----------

  _gates(item, fb, domainId) {
    const gates = [], m = this.model, cfg = this.cfg;
    const marker = MARKER.has(item.type);
    if (!marker) {
      if (this._overlapsDaily(item.start, item.end, m.sleep)) gates.push({ gate: 'sleep_window', detail: `overlaps your sleep window (${m.sleep.start}–${m.sleep.end})` });
      for (const nn of m.nonNegotiables) if (this._overlapsDaily(item.start, item.end, nn)) gates.push({ gate: 'non_negotiable', detail: `overlaps "${nn.label}", which you protect` });
      const minutes = Math.round((item.end - item.start) / MIN);
      const load = this.loadForWeek(item.start, item.excludeId);
      const capT = m.caps.total, capD = (m.caps.byDomain || {})[domainId];
      if (capT && load.total + minutes > capT) gates.push({ gate: 'load_cap', detail: `this week would total ${load.total + minutes} of ${capT} min` });
      if (capD && (load.byDomain[domainId] || 0) + minutes > capD) gates.push({ gate: 'load_cap', detail: `${this._domainName(domainId)} would reach ${(load.byDomain[domainId] || 0) + minutes} of ${capD} min this week` });
    }
    if (item.intensity === 'high') {
      const gap = cfg.recoveryGapHours * H;
      const near = this.list('session', s => s.id !== item.excludeId && s.intensity === 'high' && s.domainId === domainId && !['skipped', 'missed'].includes(s.status) && s.start < item.end + gap && s.end > item.start - gap);
      if (near.length) gates.push({ gate: 'recovery_gap', detail: `"${near[0].title}" is less than ${cfg.recoveryGapHours}h away; high-intensity ${this._domainName(domainId)} blocks need that gap to recover`, sessions: near.map(s => s.id) });
    }
    if (!CRITICAL.has(item.type) && !marker) {
      const quiet = cfg.assessmentQuietHours * H;
      const a = this.list('session', s => s.id !== item.excludeId && CRITICAL.has(s.type) && s.status === 'planned' && s.start >= item.end && s.start - item.end < quiet);
      if (a.length) gates.push({ gate: 'assessment_quiet_window', detail: `"${a[0].title}" starts within ${cfg.assessmentQuietHours}h` });
    }
    if (item.calendarId && this.accounts.get(item.calendarId) && this.accounts.get(item.calendarId).adapter.readOnly) gates.push({ gate: 'read_only_calendar', detail: `calendar "${item.calendarId}" is read-only` });
    if (!marker) {
      for (const b of fb.blocks) {
        if (b.type === 'default' || !overlaps(item, b)) continue;
        const hard = b.type === 'focus' || b.type === 'ooo' || (b.type === 'working_location' && item.location && b.location && item.location !== b.location);
        if (hard) gates.push({ gate: 'calendar_hard_block', detail: `${b.type.replace('_', ' ')} block "${b.title}"` });
      }
    }
    return gates;
  }

  _clashes(item, fb) {
    if (MARKER.has(item.type)) return { busy: [], tentative: [], displaced: [] };
    const buf = this.model.preferences.buffers || {};
    const pre = (buf.pre || 0) * MIN, post = (buf.post || 0) * MIN, travel = (buf.travel || 0) * MIN;
    const hit = fb.blocks.filter(b => {
      if (b.type !== 'default' || (b.sessionId && b.sessionId === item.excludeId)) return false;
      const t = item.location && b.location && item.location !== b.location ? travel : 0;
      return overlaps(item, b, pre + t, post + t);
    });
    return {
      busy: hit.filter(b => b.status === 'busy' && !b.sessionId),
      tentative: hit.filter(b => b.status === 'tentative'),
      displaced: hit.filter(b => b.sessionId && b.status === 'busy'),
    };
  }

  _goalForHint(hint, title = '') {
    const d = hint && this.model.domains.find(x => x.id === hint || String(x.name).toLowerCase() === String(hint).toLowerCase());
    if (!d) return null;
    const words = new Set(String(title).toLowerCase().split(/\W+/).filter(w => w.length > 3));
    const score = g => g.priority * 10 - String(g.title).toLowerCase().split(/\W+/).filter(w => words.has(w)).length;
    return this.list('goal', g => g.status === 'active' && this._goalChain(g, []).domainId === d.id).sort((a, b) => score(a) - score(b) || num(a.id) - num(b.id))[0] || null;
  }

  /** Scores, explains and gates one proposed block. Hard gates always win over the score. */
  async align(item) {
    const tr = item.practiceId ? this.trace({ practiceId: item.practiceId }) : item.goalId ? this.trace({ goalId: item.goalId }) : null;
    const goal = tr && tr.goalId ? this.find(tr.goalId, 'goal') : this._goalForHint(item.domainHint, item.title);
    const alignment = !goal ? 0 : goal.status === 'active' ? ({ 1: 1, 2: 0.7, 3: 0.4 }[goal.priority] ?? 0.4) : goal.status === 'draft' ? 0.2 : 0;
    const domainId = (tr && tr.domainId) || (goal && this._goalChain(goal, []).domainId) || item.domainId || 'unaligned';
    const fb = await this.freeBusy(item.start - DAY, item.end + DAY, item.excludeId);
    const gates = this._gates(item, fb, domainId);
    const { busy, tentative, displaced } = this._clashes(item, fb);
    const tentativeBlocks = alignment < 1 ? tentative : []; // tentative yields only to tier-1 work, with a warning
    const minutes = MARKER.has(item.type) ? 0 : Math.round((item.end - item.start) / MIN);
    const load = this.loadForWeek(item.start, item.excludeId);
    const capT = this.model.caps.total, capD = (this.model.caps.byDomain || {})[domainId];
    const ratio = Math.max(capT ? (load.total + minutes) / capT : 0, capD ? ((load.byDomain[domainId] || 0) + minutes) / capD : 0);
    const displacedRecs = displaced.map(d => this.find(d.sessionId)).filter(Boolean);
    const scores = {
      alignment,
      load: +ratio.toFixed(2), // share of the tightest cap after this block; higher is worse
      recovery: gates.some(g => RECOVERY_GATES.has(g.gate)) ? 0 : displacedRecs.some(s => s.type === 'recovery') ? 0.5 : 1,
      opportunityCost: +Math.min(1, displaced.reduce((t, d) => t + d.priority, 0)).toFixed(2),
      urgency: URGENCY[item.type] ?? 0.5,
      preferenceFit: !(this.model.preferences.focusWindows || []).length ? 0.8 : this.model.preferences.focusWindows.some(w => this._withinDaily(item.start, item.end, w)) ? 1 : 0.5,
    };
    const blocked = gates.length || busy.length || tentativeBlocks.length;
    const alternative = blocked ? await this.nextSlot(item, domainId) : null;
    const outcome = blocked ? (alternative ? 'negotiate' : 'decline_with_reason')
      : !alignment ? 'defer_to_user'
      : ratio >= this.cfg.nearCapRatio || displaced.length || tentative.length ? 'accept_with_caveat' : 'accept';
    const explanation = [
      goal ? `Serves "${goal.title}" (tier ${goal.priority}, ${goal.status}).` : 'Serves no goal: unaligned. It can still be scheduled, labelled as such.',
      gates.length ? `Binding constraint: ${gates.map(g => g.detail).join('; ')}.`
        : busy.length ? `Conflicts with "${busy[0].title}".`
        : tentativeBlocks.length ? `Overlaps tentative "${tentativeBlocks[0].title}", which only tier-1 work overrides.`
        : `Load: ${pct(ratio)} of the tightest weekly cap${ratio >= this.cfg.nearCapRatio ? ' — this uses your slack' : ''}.`,
      tentative.length && !tentativeBlocks.length ? `Overrides tentative "${tentative[0].title}" (warning).` : '',
      displacedRecs.length ? `Displaces ${displacedRecs.map(s => `"${s.title}"`).join(', ')}.` : 'Displaces nothing.',
      alternative ? `Next-best: ${alternative.label}.` : blocked ? `No valid alternative in the next ${this.cfg.slotSearchDays} days.` : '',
      fb.stale.length ? `Calendar data from ${fb.stale.join(', ')} is stale.` : '',
    ].filter(Boolean).join(' ');
    return {
      outcome, scores, gates, domainId, goalId: goal ? goal.id : null, alternative, explanation, rulesVersion: VERSION,
      busy: busy.map(b => ({ title: b.title, start: b.start, end: b.end })), tentative: tentative.map(b => ({ title: b.title, start: b.start, end: b.end })),
      displaced: displacedRecs.map(s => s.id), stale: fb.stale,
    };
  }

  /** First slot that passes every gate and clashes with nothing; focus windows first. */
  async nextSlot(item, domainId, extra = []) {
    const dur = item.end - item.start, step = 30 * MIN, days = this.cfg.slotSearchDays;
    const from = Math.ceil(Math.max(item.start, this.now()) / step) * step;
    const fb = await this.freeBusy(from - DAY, from + (days + 1) * DAY, item.excludeId);
    fb.blocks.push(...extra);
    const avoid = (this.model.preferences.avoidWindows || []).filter(w => !w.domainId || w.domainId === domainId);
    const focus = this.model.preferences.focusWindows || [];
    for (const pass of focus.length ? ['focus', 'any'] : ['any']) {
      for (let t = from; t < from + days * DAY; t += step) {
        if (t === item.start) continue;
        const c = { ...item, start: t, end: t + dur };
        if (pass === 'focus' && !focus.some(w => this._withinDaily(c.start, c.end, w))) continue;
        if (avoid.some(w => this._overlapsDaily(c.start, c.end, w))) continue;
        const cl = this._clashes(c, fb);
        if (cl.busy.length || cl.tentative.length || cl.displaced.length) continue;
        if (this._gates(c, fb, domainId).length) continue;
        return { start: t, end: t + dur, label: S.localLabel(t, this.tz) };
      }
    }
    return null;
  }

  _declineText(item, a) {
    const why = a.gates.length ? {
      sleep_window: "that's outside the hours I'm available", non_negotiable: 'I have a standing commitment then',
      load_cap: 'my week is already at capacity', recovery_gap: "I'm not available then", assessment_quiet_window: "I'm keeping that time clear",
      calendar_hard_block: "I'm blocked out then", read_only_calendar: "I can't take it on that calendar",
    }[a.gates[0].gate] : "I'm already booked then";
    return `Thanks for the invite. I can't make ${S.localLabel(item.start, this.tz)} — ${why}.${a.alternative ? ` Would ${a.alternative.label} work instead?` : ''}`;
  }

  // ---------- sessions ----------

  _toEvent(s) {
    return { uid: s.icsUid || `p1pct-${this.id}-${s.id}`, title: s.title, start: s.start, end: s.end, tz: this.tz, location: s.location || null, rrule: s.rrule || null, exdates: s.exdates || [], status: s.tentative ? 'tentative' : 'confirmed', rsvp: s.rsvp || 'accepted' };
  }

  async _createSession(tx, item, o = {}) {
    const { calendarId, excludeId, domainHint, ...fields } = item;
    const tr = item.practiceId ? this.trace({ practiceId: item.practiceId }) : item.goalId ? this.trace({ goalId: item.goalId }) : { chain: [], aligned: false, missing: 'goal' };
    if (!tr.aligned && !o.ackUnaligned) throw new EngineError('needs_ack', 'unaligned session needs acknowledgement');
    const goal = tr.goalId ? this.find(tr.goalId, 'goal') : null;
    const s = tx.put({
      kind: 'session', status: 'planned', intensity: 'moderate', type: 'event', tentative: false, location: null, rrule: null, exdates: [],
      ...clone(fields),
      minutes: MARKER.has(fields.type) ? 0 : Math.round((item.end - item.start) / MIN),
      domainId: tr.domainId || 'unaligned', goalId: tr.goalId || null, goalVersion: goal ? goal.version : null,
      aligned: !!tr.aligned, exploratory: !!tr.exploratory, unaligned: !tr.aligned, ackUnaligned: !!o.ackUnaligned,
      relaxed: (o.relaxed || []).map(g => g.gate), calendarRefs: [], history: [], snoozes: [], ...clone(o.extra || {}),
    });
    const cal = o.calendarId;
    if (cal) {
      const ev = await tx.cal(cal, 'create', null, this._toEvent(s));
      s.calendarRefs.push({ calendarId: cal, eventId: ev.id, etag: ev.etag });
    }
    return s;
  }

  /**
   * Place a session. Untraceable -> needs_ack. Any hard gate -> blocked, with a proposal
   * and the next valid slot. The user (never the engine) may relax a gate explicitly.
   */
  async scheduleSession(f, { actor = 'user', ackUnaligned = false, relax = [], calendarId = null, rationale } = {}) {
    if (MARKER.has(f.type)) f = { ...f, end: f.end ?? f.start };
    else if (!(Number.isFinite(f.start) && f.end > f.start)) throw new EngineError('invalid', 'a session needs start < end (epoch ms)');
    const tr = f.practiceId ? this.trace({ practiceId: f.practiceId }) : f.goalId ? this.trace({ goalId: f.goalId }) : { chain: [], aligned: false, missing: 'practice or goal' };
    if (!tr.aligned && !ackUnaligned) {
      return { status: 'needs_ack', trace: clone(tr.chain), message: `"${f.title}" does not trace to an active goal (missing: ${tr.missing}). It can still be scheduled: acknowledge it and it will be labelled unaligned.` };
    }
    const item = { type: f.practiceId ? 'practice' : 'event', intensity: 'moderate', ...clone(f), calendarId };
    const a = await this.align(item);
    const relaxed = actor === 'user' ? a.gates.filter(g => relax.includes(g.gate)) : [];
    const binding = a.gates.filter(g => !relaxed.includes(g)).concat(actor === 'user' ? [] : a.busy.map(b => ({ gate: 'busy', detail: `busy: "${b.title}"` })));
    if (binding.length) {
      const p = await this._queueNow({ type: 'blocked', rationale: `Not scheduled. ${a.explanation}`, confidence: 1, trace: tr.chain, payload: { item, gates: binding, alternative: a.alternative, ackUnaligned, alignment: a } }, actor);
      return { status: 'blocked', gates: binding, alternative: a.alternative, proposalId: p.id, explanation: a.explanation };
    }
    const why = rationale || (relaxed.length ? `scheduled; you relaxed ${relaxed.map(g => g.gate).join(', ')}` : 'scheduled');
    const { result, undo } = await this._tx(actor, why, tx => this._createSession(tx, item, { ackUnaligned, calendarId, relaxed }));
    return { status: 'committed', session: clone(result), undo, relaxed: relaxed.map(g => g.gate), caveat: a.outcome === 'accept_with_caveat' || a.busy.length ? a.explanation : null };
  }

  async _applyMove(tx, b, reason, { localOnly = false, force = false } = {}) {
    const s = tx.edit(b.sessionId, 'session');
    s.history.push({ at: this.now(), from: { start: s.start, end: s.end, intensity: s.intensity }, to: clone(b.after), reason });
    Object.assign(s, clone(b.after), clone(b.extra || {}));
    s.minutes = MARKER.has(s.type) ? 0 : Math.round((s.end - s.start) / MIN);
    if (localOnly) { s.dirty = true; return s; }
    for (const ref of s.calendarRefs) {
      const ev = await tx.cal(ref.calendarId, 'update', ref.eventId, { start: s.start, end: s.end, title: s.title }, force ? {} : { etag: ref.etag });
      ref.etag = ev.etag;
    }
    s.dirty = false;
    return s;
  }

  async moveSession(id, to, { actor = 'user', relax = [], reason = 'moved by you' } = {}) {
    const s = this.get(id, 'session');
    const a = await this.align({ ...s, start: to.start, end: to.end, excludeId: id });
    const binding = a.gates.filter(g => !(actor === 'user' && relax.includes(g.gate)));
    if (binding.length) return { status: 'blocked', gates: binding, alternative: a.alternative, explanation: a.explanation };
    try {
      const { undo } = await this._tx(actor, reason, tx => this._applyMove(tx, { sessionId: id, after: { start: to.start, end: to.end } }, reason));
      return { status: 'moved', undo, caveat: a.busy.length || a.displaced.length ? a.explanation : null };
    } catch (e) {
      if (e.code === 'conflict') {
        const p = await this._queueNow({
          type: 'conflict', dedupKey: `conflict:${id}`, confidence: 1, affected: [id], trace: this.trace(id).chain,
          rationale: `"${s.title}" was changed on ${e.calendarId} while you edited it here. Both versions are below; nothing has been merged.`,
          payload: { sessionId: id, calendarId: e.calendarId, local: { start: to.start, end: to.end }, remote: e.remote },
        }, actor);
        return { status: 'conflict', proposalId: p.id };
      }
      if (e.code === 'unavailable' || e.code === 'quota') {
        const acc = this.accounts.get(e.calendarId);
        if (acc) this._unhealthy(acc, e);
        const { undo } = await this._tx(actor, `${reason} (saved locally; ${e.calendarId} unreachable)`, tx => this._applyMove(tx, { sessionId: id, after: { start: to.start, end: to.end } }, reason, { localOnly: true }));
        return { status: 'saved_locally', stale: true, undo };
      }
      throw e;
    }
  }

  async deleteSession(id, { calendarScope, scope, instance, actor = 'user', reason = 'deleted by you' } = {}) {
    const s = this.get(id, 'session');
    if (s.calendarRefs.length > 1 && !calendarScope) return { status: 'needs_scope', message: `"${s.title}" is on ${s.calendarRefs.length} calendars. Delete it from one (calendarScope: id) or all?`, calendars: s.calendarRefs.map(r => r.calendarId) };
    if (s.rrule && !scope) return { status: 'needs_scope', message: `"${s.title}" repeats. Delete this instance, this and following, or the series?` };
    const refs = calendarScope && calendarScope !== 'all' ? s.calendarRefs.filter(r => r.calendarId === calendarScope) : s.calendarRefs;
    const { undo } = await this._tx(actor, reason, tx => this._deleteSession(tx, id, { refs, scope: scope || 'series', instance }));
    return { status: 'deleted', undo };
  }

  async _deleteSession(tx, id, { refs, scope = 'series', instance }) {
    const s = tx.edit(id, 'session');
    for (const r of refs) await tx.cal(r.calendarId, 'delete', r.eventId, null, { scope, instance });
    if (scope === 'this') { s.exdates.push(instance); return s; }
    if (scope === 'following') { s.rrule = S.withUntil(s.rrule, instance - 1000); return s; }
    const gone = new Set(refs.map(r => r.eventId));
    s.calendarRefs = s.calendarRefs.filter(r => !gone.has(r.eventId));
    if (!s.calendarRefs.length) { s.status = 'cancelled'; s.deletedAt = this.now(); } // soft delete: purged after the grace period
    return s;
  }

  async logSession(sessionId, log, { at = this.now() } = {}) {
    this.get(sessionId, 'session');
    return this.ingest({ type: 'session_log', source: 'manual', authority: 'user', confidence: 1, timestamp: at, idempotencyKey: `log:${sessionId}:${at}`, subject: { sessionId }, payload: clone(log) });
  }
  async recordMetric(goalId, indicator, value, { at = this.now() } = {}) {
    this.get(goalId, 'goal');
    return this.ingest({ type: 'metric', source: 'manual', authority: 'user', confidence: 1, timestamp: at, idempotencyKey: `metric:${goalId}:${indicator}:${at}`, subject: { goalId }, payload: { indicator, value } });
  }
  async journal(text, { at = this.now(), mood = null, goalId = null } = {}) {
    return this.ingest({ type: 'journal', source: 'manual', authority: 'user', confidence: 1, timestamp: at, idempotencyKey: `journal:${at}`, subject: { goalId }, payload: { text, mood } });
  }

  // ---------- signals in ----------

  emailContext() {
    const m = this.model;
    return { tz: this.tz, now: this.now(), trustedDomains: m.trustedDomains, optInSenders: m.optInSenders, domains: m.domains.map(d => ({ id: d.id, keywords: [d.name, ...(d.keywords || [])] })) };
  }

  /** The one door for every signal. Re-delivery of the same idempotency key is a no-op. */
  async ingest(sig, opts = {}) {
    const errs = S.validateSignal(sig);
    if (errs.length) throw new EngineError('invalid', `signal rejected: ${errs.join('; ')}`);
    const key = sig.idempotencyKey;
    if (this.idem.has(key)) return { ...clone(this.idem.get(key)), duplicate: true };
    // Check-and-set with no await between: two deliveries arriving together still run once.
    if (this.inflight.has(key)) return { ...clone(await this.inflight.get(key)), duplicate: true };
    const p = this._ingest(sig, opts);
    this.inflight.set(key, p);
    try { const out = await p; this.idem.set(key, clone(out)); return clone(out); }
    finally { this.inflight.delete(key); }
  }

  async _ingest(sig, { raw } = {}) {
    const actor = sig.authority === 'user' ? 'user' : 'system';
    const { result, traceId, undo } = await this._tx(actor, `signal ${sig.type} from ${sig.source}`, async tx => {
      const rec = tx.put({ kind: 'signal', ...clone(sig), receivedAt: this.now() });
      const handler = { email: '_onEmail', calendar_change: '_onCalendarChange', readiness: '_onReadiness', session_log: '_onSessionLog' }[sig.type];
      const out = handler ? await this[handler](tx, rec) : { action: 'stored' };
      rec.result = out.action;
      return { signalId: rec.id, ...out };
    });
    let out = { ...result, traceId, undo };
    if (raw != null) this.raw.set(result.signalId, { at: this.now(), body: String(raw) });
    if (result.autoCommit) out = await this._autoCommit(out);
    return out;
  }

  async _autoCommit(out) {
    const id = out.autoCommit;
    delete out.autoCommit;
    try {
      const { result, undo } = await this._tx('system', `auto-committed: confidence ≥ ${this.cfg.autoCreate}, trusted sender, aligned, no conflicts`, async tx => {
        const q = tx.edit(id);
        q.status = 'auto_committed';
        const r = await this._commitEvent(tx, q, {});
        tx.put({ kind: 'notice', text: `Added "${r.session.title}" at ${S.localLabel(r.session.start, this.tz)}. ${q.rationale}`, proposalId: id, sessionId: r.session.id });
        return r;
      });
      return { ...out, action: 'committed', sessionId: result.session.id, cascade: result.cascade, undo };
    } catch (e) {
      if (!['unavailable', 'quota', 'read_only', 'conflict', 'duplicate'].includes(e.code)) throw e;
      await this._tx('system', `auto-commit failed (${e.code}); left for you to approve`, tx => {
        const q = tx.edit(id);
        q.payload = { ...q.payload, tier: 2, tier1Blockers: [...q.payload.tier1Blockers, `calendar write failed: ${e.code}`] };
      });
      return { ...out, action: 'queued', tier: 2 };
    }
  }

  notices() {
    return this.list('notice').map(n => ({ ...clone(n), undo: (this.audit.find(a => a.id === n.id) || {}).undo || null }));
  }
  digest() {
    return this.list('signal', s => s.type === 'email' && (s.payload.class === 'newsletter' || (s.payload.class === 'notification' && !s.payload.tags.some(t => t === 'auto_reply' || t === 'out_of_office')))).map(s => ({ at: s.timestamp, from: s.payload.from, summary: s.payload.summary }));
  }

  _itemFromExtraction(ex, cls, tags = []) {
    if (cls === 'deadline') {
      const at = ex.deadline ? S.atLocal(ex.deadline, '23:59', this.tz) : ex.start;
      return { title: ex.title, type: 'deadline', start: at, end: at, domainHint: ex.domainHint };
    }
    return {
      title: ex.title, type: ex.allDay ? 'all_day' : 'event', start: ex.start, end: ex.end, allDay: ex.allDay,
      location: ex.location, domainHint: ex.domainHint, rrule: ex.recurrence || null, exdates: ex.exdates || [],
      tentative: tags.includes('tentative'),
    };
  }

  async _onEmail(tx, sig) {
    const p = sig.payload, x = p.extraction, cfg = this.cfg;
    if (p.quarantined) return { action: 'quarantined', reason: 'looks like spam or phishing; never used for scheduling' };
    if (p.excluded) return { action: 'excluded', reason: 'automated sender, auto-reply or mailing list — opt in per sender to change this' };
    if (p.class === 'newsletter' || p.class === 'notification') return { action: 'summarized' };
    if (!S.SCHEDULABLE.has(p.class)) return { action: 'stored' };
    // Same event = same .ics UID; or same thread when either side has no UID (a reply, a forward).
    const sameEvent = e => !!e && (x.icsUid && e.icsUid ? e.icsUid === x.icsUid : e.threadId === x.threadId);
    const session = this.list('session', s => sameEvent(s.extraction))[0] || null;
    const pending = this.list('proposal', q => ['pending', 'deferred'].includes(q.status) && ['event_proposal', 'possible_item', 'reschedule'].includes(q.type) && sameEvent(q.payload.extraction))[0] || null;
    const key = session ? session.dedupKey : pending ? pending.dedupKey : x.icsUid ? `uid:${x.icsUid}` : `thread:${x.threadId}`;

    if (p.class === 'meeting_cancel') return this._onCancel(tx, sig, key, session, pending);

    if (x.start == null || sig.confidence < cfg.approvalFloor) {
      if (session || pending) { if (pending && !pending.signalIds.includes(sig.id)) tx.edit(pending.id).signalIds.push(sig.id); return { action: 'thread_note' }; }
      const q = this._queue(tx, {
        type: 'possible_item', dedupKey: key, signalId: sig.id, confidence: sig.confidence,
        rationale: `Possible schedule item — low confidence (${sig.confidence}). "${x.title}" from ${p.from}${x.display ? `, perhaps ${x.display.user}` : ''}. Nothing is scheduled unless you add it.`,
        payload: { extraction: x },
      });
      return { action: 'possible_item', proposalId: q.id };
    }

    // The .ics beats prose; a newer SEQUENCE beats an older one.
    const prev = pending ? pending.payload.extraction : session ? session.extraction : null;
    let ex = x;
    if (prev && prev.path === 'ics' && (x.path !== 'ics' || x.sequence < prev.sequence)) {
      ex = prev;
      if (x.path !== 'ics' && x.start !== prev.start) {
        const note = { field: 'start', ics: prev.start, body: x.start, kept: 'ics' };
        if (!prev.conflicts.some(c => JSON.stringify(c) === JSON.stringify(note))) ex = { ...prev, conflicts: [...prev.conflicts, note] };
      }
    }
    if (session) {
      if (ex.start === session.start && ex.end === session.end) return { action: 'no_change', sessionId: session.id };
      return this._proposeReschedule(tx, sig, key, session, ex);
    }
    if (pending && prev && ex.start === prev.start && ex.end === prev.end && ex.title === prev.title && ex.conflicts.length === prev.conflicts.length) {
      if (!pending.signalIds.includes(sig.id)) tx.edit(pending.id).signalIds.push(sig.id);
      return { action: 'merged', proposalId: pending.id };
    }

    const item = this._itemFromExtraction(ex, p.class, p.tags);
    const a = await this.align(item);
    const blockers = [];
    if (sig.confidence < cfg.autoCreate) blockers.push(`confidence ${sig.confidence} is below ${cfg.autoCreate}`);
    if (!p.trusted) blockers.push('sender is not on your trusted list');
    for (const g of a.gates) blockers.push(g.gate);
    if (a.busy.length || a.tentative.length) blockers.push('something else is in that window');
    if (ex.tzAmbiguous) blockers.push(`time zone needs confirming (${ex.tzNote})`);
    if (ex.conflicts.length) blockers.push('the .ics and the message text disagree');
    if (!a.goalId) blockers.push('serves no goal');
    if (!ex.rruleSupported) blockers.push('recurrence rule is not fully supported');
    if (!['accept', 'accept_with_caveat'].includes(a.outcome)) blockers.push(`outcome is ${a.outcome}`);
    const display = ex.display ? ` ${ex.display.user}${ex.display.sender ? ` (${ex.display.sender} for the sender)` : ''}.` : '';
    const q = this._queue(tx, {
      type: 'event_proposal', dedupKey: key, signalId: sig.id, confidence: sig.confidence,
      rationale: `${a.outcome.replace(/_/g, ' ')}: "${ex.title}"${display} ${a.explanation}`,
      trace: a.goalId ? this.trace({ goalId: a.goalId }).chain : [], affected: a.displaced,
      payload: {
        item, extraction: ex, alignment: a, outcome: a.outcome, unaligned: !a.goalId,
        sendableReason: ['decline_with_reason', 'negotiate'].includes(a.outcome) ? this._declineText(item, a) : null,
        tier: blockers.length ? 2 : 1, tier1Blockers: blockers,
      },
    });
    if (!blockers.length && !pending) return { action: 'queued', proposalId: q.id, outcome: a.outcome, tier: 1, autoCommit: q.id };
    return { action: pending ? 'updated_in_place' : 'queued', proposalId: q.id, outcome: a.outcome, tier: blockers.length ? 2 : 1 };
  }

  async _commitEvent(tx, q, edits = {}) {
    const P = q.payload, ex = P.extraction || {};
    const item = { ...P.item };
    for (const k of ['start', 'end', 'title', 'location']) if (edits[k] !== undefined) item[k] = edits[k];
    const calendarId = edits.calendarId || this._primaryCalendar();
    const s = await this._createSession(tx, { ...item, goalId: edits.goalId || (P.alignment && P.alignment.goalId) || null }, {
      calendarId, ackUnaligned: true, // approving an unaligned proposal is the acknowledgement
      extra: { dedupKey: q.dedupKey || null, icsUid: ex.icsUid || null, icsSequence: ex.sequence || 0, extraction: ex, proposalId: q.id, signalId: q.signalIds[0] || null, rsvp: tx.actor === 'user' ? 'accepted' : 'needs_action' },
    });
    const cascade = MARKER.has(s.type) ? { action: 'none' } : await this._replanAround(tx, { start: s.start, end: s.end, excludeId: s.id }, `accepted "${s.title}"`);
    return { session: s, cascade };
  }

  async _proposeReschedule(tx, sig, key, session, ex) {
    const a = await this.align({ ...session, start: ex.start, end: ex.end, excludeId: session.id });
    const q = this._queue(tx, {
      type: 'reschedule', dedupKey: key, signalId: sig.id, confidence: sig.confidence, trace: this.trace(session.id).chain, affected: [session.id, ...a.displaced],
      rationale: `"${session.title}" moved: ${S.localLabel(session.start, this.tz)} → ${S.localLabel(ex.start, this.tz)}. Same event, same id. ${a.explanation}`,
      payload: { sessionId: session.id, from: { start: session.start, end: session.end }, to: { start: ex.start, end: ex.end }, extraction: ex, alignment: a },
    });
    return { action: 'reschedule_proposed', proposalId: q.id };
  }

  async _onCancel(tx, sig, key, session, pending) {
    if (pending && !session) {
      const q = tx.edit(pending.id);
      q.status = 'withdrawn';
      q.decisionReason = 'the sender cancelled it before you decided';
      return { action: 'proposal_withdrawn', proposalId: q.id };
    }
    if (!session) return { action: 'stored', note: 'cancellation for an event that was never scheduled' };
    const x = sig.payload.extraction;
    const single = x.recurrenceId != null;
    const instances = single ? [x.recurrenceId] : this._instances(session, this.now(), this.now() + 366 * DAY).map(i => i.start);
    const recurring = !!session.rrule && !single;
    const q = this._queue(tx, {
      type: 'cancel', dedupKey: `cancel:${key}`, signalId: sig.id, confidence: sig.confidence, affected: [session.id], trace: this.trace(session.id).chain,
      rationale: `${sig.payload.from} cancelled "${session.title}". ${recurring ? `It is a series: ${instances.length} upcoming instances are listed. Choose this instance, this and following, or the whole series — nothing is deleted until you do.` : 'Delete it?'}`,
      payload: { sessionId: session.id, recurring, scope: single ? 'this' : null, instance: single ? x.recurrenceId : null, instances, instanceLabels: instances.slice(0, 60).map(t => S.localLabel(t, this.tz)) },
    });
    return { action: 'cancel_proposed', proposalId: q.id, instances: instances.length };
  }

  async _onCalendarChange(tx, sig) {
    const { calendarId, eventId, change, event } = sig.payload;
    const s = this.list('session', x => x.calendarRefs.some(r => r.calendarId === calendarId && r.eventId === eventId))[0];
    if (!s) {
      if (change === 'deleted' || !event) return { action: 'none' };
      const cascade = await this._replanAround(tx, { start: event.start, end: event.end, location: event.location }, `calendar change: "${event.title}"`);
      return { action: cascade.action === 'none' ? 'none' : 'replanned', cascade };
    }
    if (change === 'deleted') {
      const live = tx.edit(s.id);
      live.calendarRefs = live.calendarRefs.filter(r => !(r.calendarId === calendarId && r.eventId === eventId));
      if (!live.calendarRefs.length) { live.status = 'cancelled'; live.deletedAt = this.now(); }
      return { action: 'deleted_locally', sessionId: s.id };
    }
    const ref = s.calendarRefs.find(r => r.calendarId === calendarId && r.eventId === eventId);
    if (event.etag === ref.etag) return { action: 'none' };
    if (s.dirty) {
      const q = this._queue(tx, {
        type: 'conflict', dedupKey: `conflict:${s.id}`, confidence: 1, affected: [s.id], trace: this.trace(s.id).chain,
        rationale: `"${s.title}" changed on ${calendarId} and here. Both versions are below; nothing has been merged.`,
        payload: { sessionId: s.id, calendarId, local: { start: s.start, end: s.end }, remote: event },
      });
      return { action: 'conflict', proposalId: q.id };
    }
    const moved = event.start !== s.start || event.end !== s.end;
    const live = tx.edit(s.id);
    live.history.push({ at: this.now(), from: { start: live.start, end: live.end }, to: { start: event.start, end: event.end }, reason: `changed on ${calendarId}` });
    Object.assign(live, { start: event.start, end: event.end, title: event.title ?? live.title, location: event.location ?? live.location, minutes: Math.round((event.end - event.start) / MIN) });
    live.calendarRefs.find(r => r.calendarId === calendarId && r.eventId === eventId).etag = event.etag;
    const cascade = moved ? await this._replanAround(tx, { start: event.start, end: event.end, excludeId: s.id }, `"${s.title}" moved on ${calendarId}`) : { action: 'none' };
    return { action: 'updated_locally', sessionId: s.id, cascade };
  }

  async _onReadiness(tx, sig) {
    const { score } = sig.payload;
    if (!(score < this.cfg.readinessFloor)) return { action: 'none' };
    const day = S.dayKey(sig.timestamp, this.tz);
    const hi = this.list('session', s => s.status === 'planned' && s.intensity === 'high' && S.dayKey(s.start, this.tz) === day);
    // Degrade to the minimum dose, never skip.
    const moves = hi.map(s => ({ sessionId: s.id, after: { intensity: 'low', end: s.start + this._mvd(s) * MIN, degraded: true } }));
    const cascade = await this._cascade(tx, `readiness ${score} is below ${this.cfg.readinessFloor}`, moves);
    return { action: cascade.action === 'none' ? 'none' : 'degraded', cascade };
  }

  _mvd(s) { const p = s.practiceId && this.find(s.practiceId, 'practice'); return (p && p.mvd && p.mvd.minutes) || s.minutes; }

  async _onSessionLog(tx, sig) {
    const L = sig.payload;
    if (!LOG_STATUS.includes(L.status)) throw new EngineError('invalid', `log status is one of ${LOG_STATUS.join(', ')}`);
    const s0 = this.get(sig.subject.sessionId, 'session');
    const before = s0.practiceId ? this.streak(s0.practiceId) : null;
    const s = tx.edit(s0.id);
    Object.assign(s, { status: L.status, rpe: L.rpe ?? s.rpe ?? null, actualMinutes: L.minutes ?? (['skipped', 'missed'].includes(L.status) ? 0 : L.status === 'minimum' ? this._mvd(s) : s.minutes), missReason: L.reason || null, note: L.note || null, loggedAt: sig.timestamp });
    const out = { action: 'logged', sessionId: s.id };
    if (s.practiceId && ['skipped', 'missed'].includes(L.status)) Object.assign(out, await this._afterMiss(tx, s, before));
    return out;
  }

  async _afterMiss(tx, s, before) {
    const out = {}, p = this.get(s.practiceId, 'practice');
    const recent = this.list('session', x => x.practiceId === p.id && x.status !== 'planned' && x.start <= s.start).sort((a, b) => b.start - a.start).slice(0, 2);
    if (recent.length === 2 && recent.every(x => ['skipped', 'missed'].includes(x.status))) {
      out.whyPrompt = this._queue(tx, {
        type: 'why_prompt', dedupKey: `why:${p.id}:${S.dayKey(s.start, this.tz)}`, confidence: 1, affected: recent.map(x => x.id), trace: this.trace(s.id).chain,
        rationale: `"${p.title}" was missed twice in a row (${recent.map(x => S.dayKey(x.start, this.tz)).reverse().join(', ')}). What got in the way? Your answer goes to the replanner and the weekly review.`,
        payload: { practiceId: p.id },
      }).id;
    }
    if (before && before.current >= 2) {
      const mvd = this._mvd(s), from = Math.max(this.now(), s.end);
      const slot = await this.nextSlot({ ...s, start: from, end: from + mvd * MIN, intensity: 'low', excludeId: s.id }, s.domainId);
      out.reentry = this._queue(tx, {
        type: 'reentry', dedupKey: `reentry:${p.id}`, confidence: 1, affected: [s.id], trace: this.trace(s.id).chain,
        rationale: `A ${before.current}-session run on "${p.title}" ended. That is data, not failure, and the record stays. Re-entry: one session at the minimum dose (${mvd} min), ${slot ? slot.label : 'at a time you choose'}. Just one day.`,
        payload: { practiceId: p.id, minutes: mvd, slot, previousRun: before.current },
      }).id;
    }
    return out;
  }

  async sweepMissed() {
    const cut = this.now() - this.cfg.missedAfterHours * H, out = [];
    for (const s of this.list('session', s => s.status === 'planned' && s.practiceId && !MARKER.has(s.type) && s.end < cut).sort((a, b) => a.start - b.start)) {
      out.push(await this.ingest({ type: 'session_log', source: 'engine:sweep', authority: 'inferred', confidence: 0.9, timestamp: s.end, idempotencyKey: `sweep:${s.id}`, subject: { sessionId: s.id }, payload: { status: 'missed', reason: null } }));
    }
    return out;
  }

  // ---------- replanning ----------

  _isCritical(s) {
    if (CRITICAL.has(s.type) || s.protected) return true;
    const p = s.practiceId && this.find(s.practiceId, 'practice');
    if (p && p.protected) return true;
    const m = p && p.milestoneId && this.find(p.milestoneId, 'milestone');
    return !!(m && m.critical);
  }

  async _replanAround(tx, block, reason) {
    const hit = this.list('session', s => s.status === 'planned' && s.id !== block.excludeId && s.practiceId && !MARKER.has(s.type) && s.start >= this.now() && this._instances(s, block.start, block.end).length);
    const moves = [], taken = [{ ...block, status: 'busy', type: 'default', title: 'new commitment' }];
    for (const s of hit.sort((a, b) => a.start - b.start)) {
      const alt = await this.nextSlot({ ...s, excludeId: s.id }, s.domainId, taken);
      if (alt) taken.push({ start: alt.start, end: alt.end, status: 'busy', type: 'default', title: s.title });
      moves.push({ sessionId: s.id, after: alt ? { start: alt.start, end: alt.end } : null });
    }
    return this._cascade(tx, reason, moves);
  }

  /** ≤ cascadeAutoMax non-critical moves: applied with one undo token. Anything bigger: you decide. */
  async _cascade(tx, reason, moves) {
    if (!moves.length) return { action: 'none' };
    const rows = moves.map(m => {
      const s = this.get(m.sessionId);
      return { sessionId: s.id, title: s.title, before: { start: s.start, end: s.end, intensity: s.intensity }, after: m.after, unplaceable: !m.after, critical: this._isCritical(s) };
    });
    const critical = rows.filter(r => r.critical);
    if (rows.length <= this.cfg.cascadeAutoMax && !critical.length && rows.every(r => !r.unplaceable)) {
      for (const r of rows) await this._applyMove(tx, r, reason);
      return { action: 'auto_replanned', moves: clone(rows) };
    }
    const q = this._queue(tx, {
      type: 'replan_interrupt', confidence: 1, affected: rows.map(r => r.sessionId),
      rationale: `${reason}: ${rows.length} session${rows.length > 1 ? 's' : ''} affected${critical.length ? `, including ${critical.map(r => `"${r.title}"`).join(', ')} (assessment, mock, milestone-critical or protected)` : ''}${rows.some(r => r.unplaceable) ? `; some have no valid slot in the next ${this.cfg.slotSearchDays} days` : ''}. Before and after are below; nothing has moved.`,
      payload: { reason, moves: rows },
    });
    return { action: 'interrupt', proposalId: q.id, moves: clone(rows) };
  }

  // ---------- calendar sync ----------

  async syncCalendar(calId) {
    const acc = this._account(calId);
    let remote;
    try { remote = await acc.adapter.list({ from: this.now() - 30 * DAY, to: this.now() + 180 * DAY }); this._healthy(acc); }
    catch (e) { if (!e.code) throw e; this._unhealthy(acc, e); return { status: 'stale', error: e.code, nextRetryAt: acc.health.nextRetryAt }; }
    const byId = new Map(remote.map(e => [e.id, e])), results = [];
    for (const s of this.list('session', s => s.calendarRefs.some(r => r.calendarId === calId))) {
      const ref = s.calendarRefs.find(r => r.calendarId === calId);
      try {
        const ev = byId.get(ref.eventId) || (await acc.adapter.get(ref.eventId)); // outside the window is not deleted
        const sig = ev
          ? { change: 'updated', event: ev, key: `${calId}:${ev.id}:${ev.etag}` }
          : { change: 'deleted', event: null, key: `${calId}:${ref.eventId}:deleted` };
        if (ev && ev.etag === ref.etag) {
          if (s.dirty) {
            const { undo } = await this._tx('system', `pushed local change to ${calId}`, tx => this._applyMove(tx, { sessionId: s.id, after: { start: s.start, end: s.end } }, 'sync: pushed local change'));
            results.push({ id: s.id, action: 'pushed', undo });
          }
          continue;
        }
        const r = await this.ingest({ type: 'calendar_change', source: `calendar:${calId}`, authority: 'provider', confidence: 1, timestamp: this.now(), idempotencyKey: sig.key, subject: { sessionId: s.id }, payload: { calendarId: calId, eventId: ref.eventId, change: sig.change, event: sig.event } });
        results.push({ id: s.id, action: r.action });
      } catch (e) { results.push({ id: s.id, action: 'error', code: e.code, error: e.message }); } // per-item, never all-or-nothing
    }
    return { status: 'ok', results };
  }

  async syncAll() {
    const results = [], notices = [];
    let quota = false;
    for (const acc of [...this.accounts.values()].sort((a, b) => b.essential - a.essential)) {
      if (quota && !acc.essential) { results.push({ id: acc.id, status: 'paused', reason: 'quota pressure: non-essential syncs pause first' }); continue; }
      if (acc.health.nextRetryAt && acc.health.nextRetryAt > this.now()) { results.push({ id: acc.id, status: 'backoff', nextRetryAt: acc.health.nextRetryAt }); continue; }
      const r = await this.syncCalendar(acc.id);
      results.push({ id: acc.id, ...r });
      if (r.error === 'quota') quota = true;
    }
    if (quota) notices.push('A calendar provider hit its quota. Non-essential syncs are paused; essential calendars keep their turn.');
    for (const r of results.filter(r => r.status === 'stale')) notices.push(`${r.id} is unreachable; working from local state, retrying at ${S.localLabel(r.nextRetryAt, this.tz)}.`);
    return { results, notices };
  }

  // ---------- development tracking ----------

  _series(goalId, name) {
    return this.list('signal', s => s.type === 'metric' && s.subject.goalId === goalId && s.payload.indicator === name).map(s => ({ t: s.timestamp, v: s.payload.value })).sort((a, b) => a.t - b.t);
  }
  _targetMs(g) { return S.atLocal(g.targetDate, '23:59', this.tz); }

  /** Honest forecast per lagging indicator, assumptions spelled out. */
  forecast(goalId) {
    const g = this.get(goalId, 'goal'), out = [];
    for (const ind of g.lagging) {
      const pts = this._series(goalId, ind.name);
      if (ind.target == null) { out.push({ indicator: ind.name, status: 'no_numeric_target', assumptions: `"${ind.name}" has no number to forecast against. Give it a target to get a forecast.` }); continue; }
      if (pts.length < 2) { out.push({ indicator: ind.name, status: 'insufficient_data', points: pts.length, assumptions: `A forecast needs at least two measurements of "${ind.name}"; there ${pts.length === 1 ? 'is one' : 'are none'}.` }); continue; }
      const dir = dirOf(ind, pts), last = pts[pts.length - 1];
      const tm = pts.reduce((t, p) => t + p.t, 0) / pts.length, vm = pts.reduce((t, p) => t + p.v, 0) / pts.length;
      const slope = pts.reduce((t, p) => t + (p.t - tm) * (p.v - vm), 0) / (pts.reduce((t, p) => t + (p.t - tm) ** 2, 0) || 1);
      const remaining = (ind.target - last.v) * dir;
      let status, eta = null;
      if (remaining <= 0) status = 'achieved';
      else if (slope * dir <= 0) status = 'will_miss';
      else { eta = Math.round(last.t + remaining / (slope * dir)); status = eta <= this._targetMs(g) ? 'on_track' : 'will_miss'; }
      const rate = fmtNum(slope * 7 * DAY);
      out.push({
        indicator: ind.name, status, current: last.v, target: ind.target, ratePerWeek: rate, eta, etaDate: eta ? S.dayKey(eta, this.tz) : null, targetDate: g.targetDate,
        assumptions: `Straight-line trend over ${pts.length} measurements (${S.dayKey(pts[0].t, this.tz)} to ${S.dayKey(last.t, this.tz)}), ${rate} per week, continues. It ignores plateaus, injury, illness and deload weeks.${slope * dir <= 0 && remaining > 0 ? ' At this rate the target is not reached at all.' : ''}`,
      });
    }
    return out;
  }

  divergence(goalId) {
    const g = this.get(goalId, 'goal'), out = [], since = this.now() - 28 * DAY;
    const fc = Object.fromEntries(this.forecast(goalId).map(f => [f.indicator, f]));
    for (const L of g.leading) {
      const lp = this._series(goalId, L.name);
      if (lp.length < 2 || L.target == null) continue;
      const ld = dirOf(L, lp), lv = lp[lp.length - 1].v;
      const leadHealthy = (lv - L.target) * ld >= -Math.abs(L.target) * 0.1;
      const lr = lp.filter(p => p.t >= since);
      const leadDeclining = lr.length >= 2 && (lr[lr.length - 1].v - lr[0].v) * ld < -Math.abs(lr[0].v) * 0.2;
      for (const G of g.lagging) {
        const all = this._series(goalId, G.name), gp = all.filter(p => p.t >= since);
        if (gp.length < 2 || G.target == null) continue;
        const gd = dirOf(G, all), first = gp[0], last = gp[gp.length - 1];
        const moved = (last.v - first.v) * gd;
        const needed = ((G.target - first.v) * gd) / Math.max(DAY, this._targetMs(g) - first.t) * (last.t - first.t);
        const days = Math.round((last.t - first.t) / DAY);
        if (leadHealthy && needed > 0 && moved < 0.25 * needed) {
          out.push({
            kind: 'lagging_gap', goalId, leading: L.name, lagging: G.name, options: ['quality', 'dosage', 'method'],
            evidence: { leading: lp.slice(-3), lagging: gp },
            text: `"${L.name}" is healthy (${lv} against ${L.target}), but "${G.name}" moved ${fmtNum(moved * gd)} in ${days} days when about ${fmtNum(needed * gd)} was needed to reach ${G.target} by ${g.targetDate}. The work is happening; the result is not following. Change one thing: quality (how the sessions are done), dosage (how much), or method (a different practice).`,
          });
        } else if (fc[G.name] && fc[G.name].status === 'on_track' && leadDeclining) {
          out.push({
            kind: 'over_delivery', goalId, leading: L.name, lagging: G.name, options: ['lighter_plan', 'keep'],
            evidence: { leading: lr, lagging: gp },
            text: `"${G.name}" is on track (forecast ${fc[G.name].etaDate}, target ${g.targetDate}) while "${L.name}" fell from ${lr[0].v} to ${lr[lr.length - 1].v}. You may be doing more than the result needs; a lighter plan could hold it.`,
          });
        }
      }
    }
    return out;
  }

  async checkDevelopment() {
    const found = [];
    for (const g of this.list('goal', g => g.status === 'active')) for (const d of this.divergence(g.id)) found.push(d);
    if (!found.length) return [];
    const { result } = await this._tx('system', 'leading/lagging divergence', tx => found.map(d => this._queue(tx, {
      type: 'strategy', dedupKey: `strategy:${d.goalId}:${d.kind}:${d.leading}:${d.lagging}`, confidence: 0.8, rationale: d.text, trace: this.trace({ goalId: d.goalId }).chain, evidence: [d.evidence],
      payload: { ...d, options: d.options.map(o => ({ option: o, text: o })) },
    })));
    return clone(result);
  }

  /** Mastery is demonstrated, not served. Transitions retune progression and review dosage. */
  async setMastery(practiceId, level, evidence) {
    if (!LEVELS.includes(level)) throw new EngineError('invalid', `level is one of ${LEVELS.join(', ')}`);
    if (!evidence || !evidence.summary) throw new EngineError('invalid', 'a mastery transition needs evidence (evidence.summary)');
    const p0 = this.get(practiceId, 'practice');
    const from = p0.mastery || 'not_started', up = LEVELS.indexOf(level) > LEVELS.indexOf(from);
    if (LEVELS.indexOf(level) >= 3 && up && !evidence.independent) throw new EngineError('invalid', 'proficient and mastered need an independent performance test, not a practised drill (evidence.independent)');
    const { undo } = await this._tx('user', `mastery ${from} → ${level}`, tx => {
      const p = tx.edit(practiceId);
      p.mastery = level;
      p.masteryLog.push({ at: this.now(), from, to: level, evidence: clone(evidence) });
      p.progression = { ...(p.progression || {}), stage: level };
      const byLevel = p.progression.byLevel && p.progression.byLevel[level];
      if (byLevel) p.target = { ...(p.target || {}), ...clone(byLevel) };
      if (LEARNING.has(p.domain)) {
        p.reviewPerWeek = REVIEW_DOSE[level];
        if (p.retrieval && p.retrieval.scheduleDays) {
          const f = up ? 2 : 0.5; // successive relearning: slipping back tightens the gaps again
          p.retrieval = { ...p.retrieval, scheduleDays: p.retrieval.scheduleDays.map(d => Math.max(1, Math.round(d * f))) };
        }
      }
    });
    return { status: 'ok', practice: clone(this.get(practiceId)), undo };
  }

  streak(practiceId) {
    let current = 0, longest = 0, previous = 0, brokenAt = null;
    for (const s of this.list('session', s => s.practiceId === practiceId && s.status !== 'planned' && !s.deletedAt).sort((a, b) => a.start - b.start)) {
      if (s.status === 'done' || s.status === 'minimum') { current++; longest = Math.max(longest, current); }
      else { if (current) { previous = current; brokenAt = s.start; } current = 0; }
    }
    return { current, longest, previous, brokenAt };
  }

  _adherence(practiceIds, from, to) {
    const ids = new Set(practiceIds);
    const ss = this.list('session', s => ids.has(s.practiceId) && !s.exploratory && LOG_STATUS.includes(s.status) && s.start >= from && s.start < to);
    const c = st => ss.filter(s => s.status === st).length;
    const done = c('done'), minimum = c('minimum'), skipped = c('skipped'), missed = c('missed'), total = ss.length;
    return { done, minimum, skipped, missed, total, rate: total ? (done + minimum) / total : null, ids: ss.map(s => s.id) };
  }

  /** Everything, including what did not work. */
  evidenceLog({ from = -Infinity, to = Infinity } = {}) {
    const E = [], inR = t => t >= from && t <= to;
    for (const s of this.list('session', s => s.practiceId && LOG_STATUS.includes(s.status) && inR(s.start))) {
      E.push({ at: s.start, type: ['done', 'minimum'].includes(s.status) ? 'progress' : 'non_progress', what: `${s.title}: ${s.status}${s.status === 'minimum' ? ' (minimum dose, counts)' : ''}${s.missReason ? ` — ${s.missReason}` : ''}${s.rpe != null ? `, RPE ${s.rpe}` : ''}`, ref: s.id });
    }
    for (const m of this.list('milestone', m => m.done && inR(m.doneAt))) E.push({ at: m.doneAt, type: 'milestone', what: `${m.title} reached`, ref: m.id });
    for (const p of this.list('practice')) for (const l of p.masteryLog || []) if (inR(l.at)) E.push({ at: l.at, type: LEVELS.indexOf(l.to) > LEVELS.indexOf(l.from) ? 'progress' : 'non_progress', what: `${p.title}: ${l.from} → ${l.to} (${l.evidence.summary})`, ref: p.id });
    for (const j of this.list('signal', s => s.type === 'journal' && inR(s.timestamp))) E.push({ at: j.timestamp, type: 'journal', what: `"${j.payload.text}"`, ref: j.id });
    for (const r of this.list('review', r => Object.keys(r.answers || {}).length)) for (const [gid, a] of Object.entries(r.answers)) if (inR(a.at)) E.push({ at: a.at, type: 'reflection', what: `${r.cadence} review on ${gid}: ${a.decision || 'answered'}${a.rationale ? ` — ${a.rationale}` : ''}`, ref: r.id });
    if (inR(this.now())) {
      for (const g of this.list('goal', g => g.status === 'active')) for (const f of this.forecast(g.id)) {
        if (['will_miss', 'insufficient_data'].includes(f.status)) E.push({ at: this.now(), type: 'non_progress', what: `"${g.title}" / ${f.indicator}: ${f.status.replace('_', ' ')}. ${f.assumptions}`, ref: g.id });
      }
    }
    return E.sort((a, b) => a.at - b.at);
  }

  goalHealth(goalId) {
    const g = this.get(goalId, 'goal'), tr = this.trace({ goalId });
    const ps = this.practicesFor(goalId);
    return clone({
      goalId, title: g.title, status: g.status, version: g.version, lastReviewed: g.lastReviewed,
      alignment: tr.aligned || tr.exploratory ? `traces to "${(tr.chain[tr.chain.length - 1] || {}).title}"` : `untraced (missing ${tr.missing})`,
      wellFormed: this.wellFormed(g), adherence: this._adherence(ps.map(p => p.id), this.now() - 28 * DAY, this.now()),
      trajectory: this.forecast(goalId), cost: this.goalCost(goalId), tests: this.goalTests(goalId), divergence: this.divergence(goalId),
      practices: ps.map(p => ({ id: p.id, title: p.title, mastery: p.mastery, streak: this.streak(p.id) })),
    });
  }

  // ---------- sustainability ----------

  async sustainabilityCheck() {
    const N = this.cfg.overCapWeeks, weeks = [];
    for (let i = 1; i <= N; i++) { const w = this.weekOf(this.now() - i * 7 * DAY); const l = this.loadForWeek(w.from); weeks.push({ week: w.key, over: this._overCaps(l), load: l }); }
    if (!weeks.every(w => w.over.length)) return null;
    const low = this.list('goal', g => g.status === 'active').sort((a, b) => b.priority - a.priority || num(a.id) - num(b.id))[0];
    const lowCost = low ? this.goalCost(low.id).minutesPerWeek : 0;
    const options = [
      { option: 'deload', text: 'Cut every practice to 60% of its target for one week', tradeoff: 'Slower progress for a week; recovery and adherence hold.' },
      ...(low ? [
        { option: 'scope_reduction', goalId: low.id, text: `Drop "${low.title}" to its minimum dose`, tradeoff: `"${low.title}" slows down; everything else keeps its pace.` },
        { option: 'pause', goalId: low.id, text: `Pause "${low.title}"`, tradeoff: `Frees about ${lowCost} min/week; progress there stops until you resume it.` },
      ] : []),
      { option: 'keep', text: 'Keep the load as it is', tradeoff: 'You stay over your own cap. If the cap is wrong, change the cap, not the evidence.' },
    ];
    return this._queueNow({
      type: 'deload', dedupKey: `deload:${weeks[0].week}`, confidence: 1,
      rationale: `Over capacity ${N} weeks running: ${weeks.map(w => `week of ${w.week}: ${w.over.join(', ')}`).join('; ')}. Choose one option; nothing changes until you do.`,
      payload: { weeks, options },
    });
  }

  // ---------- coaching ----------

  _timeOfDay() {
    const b = {};
    for (const s of this.list('session', s => s.practiceId && LOG_STATUS.includes(s.status))) {
      const k = bucketOf(S.zoned(s.start, this.tz).h);
      (b[k] = b[k] || { n: 0, done: 0, ids: [] }).n++;
      if (['done', 'minimum'].includes(s.status)) b[k].done++;
      b[k].ids.push(s.id);
    }
    const rated = Object.entries(b).filter(([, v]) => v.n >= 5).map(([k, v]) => ({ k, ...v, rate: v.done / v.n })).sort((a, b) => b.rate - a.rate);
    if (rated.length < 2 || rated[0].rate - rated[rated.length - 1].rate < 0.3) return null;
    const best = rated[0], worst = rated[rated.length - 1];
    return {
      best: best.k,
      text: `You complete ${pct(best.rate)} of ${best.k} sessions against ${pct(worst.rate)} in the ${worst.k}. Is the ${best.k} a better fit — or is something else going on?`,
      evidence: { [best.k]: { done: best.done, of: best.n, sessions: best.ids }, [worst.k]: { done: worst.done, of: worst.n, sessions: worst.ids } },
    };
  }

  /** Every observation cites its evidence. No evidence, no observation. */
  observations({ days = this.cfg.driftWindowDays } = {}) {
    const out = [], since = this.now() - days * DAY;
    const obs = o => { if (!o.evidence || !Object.keys(o.evidence).length) throw new EngineError('internal', 'observation without evidence'); out.push(o); };
    for (const p of this.list('practice', p => !p.anti)) {
      const a = this._adherence([p.id], since, this.now());
      if (a.total >= 3 && a.rate < this.cfg.driftAdherence) {
        obs({ kind: 'drift', practiceId: p.id, options: ['recommit', 'renegotiate', 'pause', 'abandon'], evidence: { sessions: a.ids, done: a.done, minimum: a.minimum, total: a.total },
          text: `"${p.title}": ${a.done + a.minimum} of ${a.total} sessions in ${days} days (${pct(a.rate)}), below your ${pct(this.cfg.driftAdherence)} line.` });
      }
      const missed = this.list('session', s => s.practiceId === p.id && s.missReason && s.start >= since);
      const counts = {};
      for (const s of missed) (counts[s.missReason.toLowerCase()] = counts[s.missReason.toLowerCase()] || []).push(s.id);
      for (const [reason, ids] of Object.entries(counts)) if (ids.length >= 3) obs({ kind: 'miss_reason', practiceId: p.id, evidence: { reason, sessions: ids }, text: `"${p.title}" was missed ${ids.length} times for the same reason: "${reason}". That is a design problem in the plan, not a character flaw.` });
      const rpe = this.list('session', s => s.practiceId === p.id && s.status === 'done' && s.rpe != null && s.start >= since).sort((a, b) => a.start - b.start);
      if (rpe.length >= 4) {
        const mins = rpe.map(s => s.actualMinutes ?? s.minutes), half = Math.floor(rpe.length / 2);
        const avg = xs => xs.reduce((t, s) => t + s.rpe, 0) / xs.length;
        const a1 = avg(rpe.slice(0, half)), a2 = avg(rpe.slice(half));
        if (Math.max(...mins) <= Math.min(...mins) * 1.15 && a2 - a1 >= 1.5) {
          obs({ kind: 'rising_rpe', practiceId: p.id, evidence: { sessions: rpe.map(s => ({ id: s.id, rpe: s.rpe, minutes: s.actualMinutes ?? s.minutes })) },
            text: `Effort on "${p.title}" rose from RPE ${a1.toFixed(1)} to ${a2.toFixed(1)} at the same ~${mins[0]} min. That often means fatigue is building. Recovery before more load?` });
        }
      }
    }
    const tod = this._timeOfDay();
    if (tod) obs({ kind: 'focus_window', text: tod.text, evidence: tod.evidence });
    for (const d of this.model.domains) {
      const cap = (this.model.caps.byDomain || {})[d.id];
      const gs = this.list('goal', g => g.status === 'active' && this._goalChain(g, []).domainId === d.id);
      if (!cap || gs.length < 2) continue;
      const planned = gs.map(g => ({ goalId: g.id, title: g.title, minutes: this.practicesFor(g.id).reduce((t, p) => t + ((p.target && p.target.minutes * (p.target.perWeek || 1)) || 0), 0) }));
      const sum = planned.reduce((t, x) => t + x.minutes, 0);
      if (sum > cap) obs({ kind: 'collision', evidence: { cap, planned }, text: `${planned.map(x => `"${x.title}"`).join(' and ')} together plan ${sum} min/week of ${d.name}; your cap is ${cap}. They cannot all get their target dose.` });
    }
    for (const p of this.list('practice', p => p.anti)) {
      const sum = (a, b) => this.list('signal', s => s.type === 'metric' && s.subject.practiceId === p.id && s.timestamp >= a && s.timestamp < b).reduce((t, s) => t + s.payload.value, 0);
      const w = this.now() - 7 * DAY, cur = sum(w, this.now()), prev = sum(w - 7 * DAY, w);
      if (cur || prev) obs({ kind: 'anti_practice', practiceId: p.id, evidence: { thisWeek: cur, lastWeek: prev, unit: p.unit || 'min' }, text: `${p.title}: ${cur} ${p.unit || 'min'} this week, ${prev} last week.` });
    }
    for (const g of this.list('goal', g => g.status === 'active')) {
      const a = this._adherence(this.practicesFor(g.id).map(p => p.id), since, this.now());
      const edits = g.versions.filter(v => v.at >= since).length;
      if (edits >= 3 && a.total >= 2 && a.rate < 0.5) obs({ kind: 'energy_without_effort', goalId: g.id, evidence: { revisions: edits, ...a }, text: `"${g.title}" was revised ${edits} times in ${days} days while ${pct(a.rate)} of its sessions happened. Planning is not the same as doing — what is in the way?` });
      const moods = this.list('signal', s => s.type === 'journal' && s.subject.goalId === g.id && s.timestamp >= since && s.payload.mood != null);
      const mood = moods.length ? moods.reduce((t, s) => t + s.payload.mood, 0) / moods.length : null;
      if (a.total >= 4 && a.rate >= 0.8 && mood != null && moods.length >= 3 && mood <= 2) obs({ kind: 'effort_without_energy', goalId: g.id, evidence: { adherence: a.rate, moods: moods.map(s => ({ id: s.id, mood: s.payload.mood })) }, text: `You are keeping "${g.title}" (${pct(a.rate)}) but your journal mood around it averages ${mood.toFixed(1)}/5. Is it still yours?` });
    }
    return clone(out);
  }

  /** Ch.2: conditions and patterns as questions. Never creates a goal. */
  async inferPatterns() {
    const found = [];
    const tod = this._timeOfDay();
    if (tod) found.push({ key: 'focus_window', text: tod.text, evidence: tod.evidence, appliesTo: 'focusWindows', suggested: [WINDOWS[tod.best]] });
    const groups = {};
    for (const s of this.list('session', s => !s.practiceId && !s.signalId && !MARKER.has(s.type))) {
      const z = S.zoned(s.start, this.tz);
      (groups[`${z.wd}|${z.h}`] = groups[`${z.wd}|${z.h}`] || []).push(s);
    }
    for (const [k, ss] of Object.entries(groups)) {
      const weeks = [...new Set(ss.map(s => this.weekOf(s.start).key))];
      if (weeks.length < 3) continue;
      const [wd, h] = k.split('|').map(Number);
      found.push({ key: `protected:${k}`, text: `You have kept ${DAYNAMES[wd]}s around ${pad(h)}:00 for ${weeks.length} weeks ("${ss[0].title}"). Is this becoming a goal — or something else?`, evidence: { sessions: ss.map(s => s.id), weeks } });
    }
    const snoozes = {};
    for (const s of this.list('session')) for (const z of s.snoozes || []) (snoozes[z.reason] = snoozes[z.reason] || []).push(s.id);
    for (const [reason, ids] of Object.entries(snoozes)) if (ids.length >= 3) found.push({ key: `snooze:${reason}`, text: `You snoozed ${ids.length} reminders with "${reason}". Should reminders move, or the sessions?`, evidence: { sessions: ids } });
    if (found.length) {
      await this._tx('system', 'inferred patterns (questions, not facts)', tx => {
        for (const f of found) {
          const ex = this.list('pattern', p => p.key === f.key)[0];
          if (!ex) { tx.put({ kind: 'pattern', status: 'open', label: 'inference', ...clone(f) }); continue; }
          const p = tx.edit(ex.id);
          p.evidence = clone(f.evidence);
          if (p.status === 'open') p.text = f.text;
        }
      });
    }
    return this.list('pattern', p => p.status === 'open').map(clone);
  }

  // ---------- reviews ----------

  _latest(type) { return this.list('signal', s => s.type === type).sort((a, b) => b.timestamp - a.timestamp)[0] || null; }

  _reviewItems(cadence, from, to) {
    const items = [], add = (kind, text, data = {}) => items.push({ kind, text, data: clone(data) });
    const tz = this.tz, label = t => S.localLabel(t, tz);
    const live = this.list('goal', g => !['abandoned', 'achieved'].includes(g.status));
    const active = live.filter(g => g.status === 'active');
    const obs = this.observations({ days: Math.max(this.cfg.driftWindowDays, Math.round((to - from) / DAY)) });

    if (cadence === 'daily') {
      const today = S.dayKey(to, tz);
      const blocks = this.list('session', s => s.status === 'planned' && S.dayKey(s.start, tz) === today).sort((a, b) => a.start - b.start);
      add('blocks', blocks.length ? blocks.map(s => `${label(s.start).slice(11, 16)} ${s.title}${s.unaligned ? ' (unaligned)' : ''}`).join('; ') : 'Nothing scheduled today.', { sessions: blocks.map(s => s.id) });
      const r = this._latest('readiness');
      add('readiness', r ? `Readiness ${r.payload.score}${r.timestamp < to - DAY ? ' (stale: more than a day old)' : ''}.` : 'No readiness signal today. How do you feel, 1–5?', { signalId: r && r.id });
      add('intention', 'One intention for today, in your words?');
      add('prompt', obs[0] ? obs[0].text : 'What would make today count, even at the minimum dose?', { evidence: obs[0] && obs[0].evidence });
      return items;
    }

    // In every review from weekly up: what failed its test, and what is drifting.
    for (const g of live) for (const f of this.goalTests(g.id)) add('goal_test_failure', `"${g.title}" fails the ${f.test} test: ${f.detail}. Renegotiate it, or keep it as it is?`, { goalId: g.id, ...f, options: ['renegotiate', 'keep'] });
    for (const o of obs.filter(o => o.kind === 'drift')) add('drift', `${o.text} Options: recommit, renegotiate, pause or abandon.`, { ...o.evidence, practiceId: o.practiceId, options: o.options });
    for (const g of active) for (const f of this.forecast(g.id).filter(f => f.status === 'will_miss')) add('drift', `"${g.title}": ${f.indicator} is forecast to miss ${g.targetDate}. ${f.assumptions} Options: recommit, renegotiate, pause or abandon.`, { goalId: g.id, forecast: f, options: ['recommit', 'renegotiate', 'pause', 'abandon'] });
    for (const s of this.list('session', s => s.status === 'planned' && s.goalId && s.start >= to)) {
      const g = this.find(s.goalId, 'goal');
      if (g && s.goalVersion != null && s.goalVersion !== g.version) add('stale_plan', `"${s.title}" was planned under v${s.goalVersion} of "${g.title}"; the goal is now v${g.version}. Does it still fit?`, { sessionId: s.id, goalId: g.id });
    }

    if (cadence === 'weekly') {
      const ps = this.list('practice', p => !p.anti);
      for (const p of ps) { const a = this._adherence([p.id], from, to); if (a.total) add('adherence', `"${p.title}": ${a.done} done, ${a.minimum} at minimum dose, ${a.skipped + a.missed} missed, of ${a.total} (${pct(a.rate)}).`, { practiceId: p.id, ...a }); }
      const l = this.loadForWeek(from + DAY), over = this._overCaps(l);
      add('load', `Load: ${l.total} of ${this.model.caps.total} min${Object.keys(l.byDomain).length ? ` (${Object.entries(l.byDomain).map(([d, m]) => `${this._domainName(d)} ${m}`).join(', ')})` : ''}.${over.length ? ` Over cap: ${over.join(', ')}.` : ''}`, l);
      const wins = this.list('session', s => ['done', 'minimum'].includes(s.status) && s.practiceId && s.start >= from && s.start < to);
      const ms = this.list('milestone', m => m.done && m.doneAt >= from && m.doneAt < to);
      if (wins.length || ms.length) add('wins', `${wins.length} sessions kept${ms.length ? `; milestones: ${ms.map(m => m.title).join(', ')}` : ''}.`, { sessions: wins.map(s => s.id), milestones: ms.map(m => m.id) });
      const misses = this.list('session', s => ['skipped', 'missed'].includes(s.status) && s.start >= from && s.start < to);
      if (misses.length) add('misses', misses.map(s => `${s.title} (${S.dayKey(s.start, tz)}): ${s.missReason || 'no reason given'}`).join('; '), { sessions: misses.map(s => s.id) });
      for (const s of this.list('session', s => s.unaligned && s.start >= from && s.start < to)) add('unaligned', `"${s.title}" was scheduled but serves no goal.`, { sessionId: s.id });
      const next = this.list('session', s => s.status === 'planned' && s.start >= to && s.start < to + 7 * DAY).sort((a, b) => a.start - b.start);
      add('next_week', next.length ? `Draft: ${next.map(s => `${label(s.start).slice(5, 16)} ${s.title}`).join('; ')}.` : 'Next week has nothing planned yet.', { sessions: next.map(s => s.id) });
      const o = obs.find(x => x.kind !== 'drift');
      if (o) add('observation', o.text, { kind: o.kind, evidence: o.evidence });
      const q = this.list('pattern', p => p.status === 'open')[0];
      add('question', q ? q.text : 'What is one change for next week — just one?', q ? { patternId: q.id } : {});
    }

    if (cadence === 'monthly' || cadence === 'quarterly') {
      for (const g of active) {
        for (const L of g.leading) { const s = this._series(g.id, L.name).filter(p => p.t >= from && p.t < to); if (s.length) add('leading_trends', `"${g.title}" / ${L.name}: ${s[0].v} → ${s[s.length - 1].v} (target ${L.target ?? 'none'}).`, { goalId: g.id, series: s }); }
        for (const G of g.lagging) { const s = this._series(g.id, G.name).filter(p => p.t >= from && p.t < to); if (s.length) add('lagging_movement', `"${g.title}" / ${G.name}: ${s[0].v} → ${s[s.length - 1].v} (target ${G.target ?? 'none'}).`, { goalId: g.id, series: s }); }
        const h = this.goalHealth(g.id);
        add('goal_health', `"${g.title}": ${h.alignment}; adherence ${h.adherence.rate == null ? 'no data' : pct(h.adherence.rate)}; cost ${h.cost.minutesPerWeek} min/week; ${h.tests.length} test failure(s).`, { goalId: g.id, health: h });
        for (const f of this.forecast(g.id)) add('forecast', `"${g.title}" / ${f.indicator}: ${f.status.replace('_', ' ')}${f.etaDate ? `, ETA ${f.etaDate}` : ''}. ${f.assumptions}`, { goalId: g.id, forecast: f });
        for (const d of this.divergence(g.id)) add('strategy', d.text, { ...d });
      }
      for (const p of this.list('practice')) for (const l of (p.masteryLog || []).filter(l => l.at >= from && l.at < to)) add('mastery', `"${p.title}": ${l.from} → ${l.to} (${l.evidence.summary}).`, { practiceId: p.id, ...l });
      const moved = this.list('session', s => s.history.some(h => h.at >= from && h.at < to));
      add('replans', moved.length ? `${moved.length} session(s) were moved or degraded this period: ${moved.map(s => s.title).join(', ')}.` : 'No sessions were replanned.', { sessions: moved.map(s => s.id) });
    }

    if (cadence === 'quarterly') {
      add('priority_rank', active.length ? active.slice().sort((a, b) => a.priority - b.priority).map((g, i) => `${i + 1}. ${g.title} (tier ${g.priority})`).join('; ') + '. Still the right order?' : 'No active goals.', { goals: active.map(g => g.id) });
      for (const v of this.list('vision')) add('vision_check', `Your ${this._domainName(v.domainId)} vision: "${v.text}". Still the picture?`, { visionId: v.id });
      add('anti_goal_check', `Your anti-goals: ${[...this.model.antiGoals, ...live.flatMap(g => g.antiGoals)].map(a => `"${a}"`).join(', ') || 'none written'}. Is any of them creeping in?`);
      const weeks = Array.from({ length: 13 }, (_, i) => this._overCaps(this.loadForWeek(to - (i + 1) * 7 * DAY)).length > 0).filter(Boolean).length;
      add('sustainability', `${weeks} of the last 13 weeks were over a cap.`, { weeksOver: weeks });
      for (const g of live) {
        add('goal_decision', `"${g.title}": continue, adjust, pause or abandon?`, { goalId: g.id, options: ['continue', 'adjust', 'pause', 'abandon'] });
        add('re_elicitation', `"${g.title}" — ${REELICIT.join(' ')}`, { goalId: g.id, questions: REELICIT });
      }
    }

    if (cadence === 'annual') {
      add('identity', `You wrote: "${this.model.identity || '(no identity statement yet)'}". Is that still who you are becoming?`);
      add('values', `Your values: ${this.model.values.map(v => `"${v.text}"`).join(', ') || 'none written'}. Did the year live by them?`);
      const E = this.evidenceLog({ from, to });
      add('evidence_log', `This year: ${E.filter(e => e.type === 'progress').length} progress records, ${E.filter(e => e.type === 'non_progress').length} non-progress records, ${E.filter(e => e.type === 'milestone').length} milestones.`, { counts: E.reduce((c, e) => ({ ...c, [e.type]: (c[e.type] || 0) + 1 }), {}) });
      add('anti_goal_reassessment', 'Your anti-goals, a year on: which still matter, and is there a new one?');
      add('major_resets', 'Is there anything to stop entirely, or start again from scratch?');
    }

    for (const kind of REQUIRED[cadence]) if (!items.some(i => i.kind === kind)) add(kind, 'Nothing to report for this period.');
    return items;
  }

  async generateReview(cadence, { at = this.now() } = {}) {
    if (!REQUIRED[cadence]) throw new EngineError('invalid', `cadence is one of ${Object.keys(REQUIRED).join(', ')}`);
    const from = at - PERIOD_DAYS[cadence] * DAY;
    const prev = this.list('review', r => r.cadence === cadence && r.status === 'draft').sort((a, b) => b.createdAt - a.createdAt)[0];
    // A missed review never resets: its undecided items carry forward.
    const carried = prev ? prev.items.filter(i => !i.decision).map(i => ({ ...clone(i), carried: true, fromReview: prev.id })) : [];
    const { result } = await this._tx('system', `generated ${cadence} review`, tx => {
      if (prev) tx.edit(prev.id).status = 'superseded';
      const items = [...this._reviewItems(cadence, from, at), ...carried].map((it, i) => ({ ...it, id: `i${i + 1}`, decision: null }));
      return tx.put({ kind: 'review', cadence, period: { from, to: at }, status: 'draft', items, answers: {}, decisionLog: [], requiredKinds: REQUIRED[cadence] });
    });
    return clone(result);
  }

  async decideReviewItem(reviewId, itemId, decision, { edit, note } = {}) {
    if (!['approve', 'edit', 'reject'].includes(decision)) throw new EngineError('invalid', 'decision is approve, edit or reject');
    const { undo } = await this._tx('user', `review item ${decision}`, tx => {
      const r = tx.edit(reviewId, 'review');
      const it = r.items.find(i => i.id === itemId);
      if (!it) throw new EngineError('not_found', 'no such review item');
      Object.assign(it, { decision, edit: edit ?? null, note: note ?? null, decidedAt: this.now() });
      if (r.items.every(i => i.decision)) { r.status = 'approved'; r.approvedAt = this.now(); }
    });
    return { status: 'ok', review: clone(this.get(reviewId)), undo };
  }

  async approveReview(reviewId) {
    const r = this.get(reviewId, 'review');
    let last;
    for (const it of r.items.filter(i => !i.decision)) last = await this.decideReviewItem(reviewId, it.id, 'approve');
    return last || { status: 'ok', review: clone(r) };
  }

  /** Ch.5: the answers are recorded, and each goal is re-authored or released — never inherited. */
  async recordAnswers(reviewId, goalId, answers) {
    const r = this.get(reviewId, 'review');
    if (!['quarterly', 'annual'].includes(r.cadence)) throw new EngineError('invalid', 're-elicitation answers belong to quarterly and annual reviews');
    const g = this.get(goalId, 'goal');
    const decision = answers.decision;
    if (!['continue', 'adjust', 'pause', 'abandon'].includes(decision)) throw new EngineError('invalid', 'decision is continue, adjust, pause or abandon');
    const why = `${r.cadence} review: ${decision}${answers.rationale ? ` — ${answers.rationale}` : ''}`;
    const { undo } = await this._tx('user', why, tx => {
      const rv = tx.edit(reviewId);
      rv.answers[goalId] = { ...clone(answers), at: this.now() };
      rv.decisionLog.push({ at: this.now(), goalId, goal: g.title, versionBefore: g.version, decision, rationale: answers.rationale || null, answers: REELICIT.map((q, i) => ({ q, a: answers[`q${i}`] ?? null })) });
      for (const it of rv.items.filter(i => ['goal_decision', 're_elicitation'].includes(i.kind) && i.data.goalId === goalId)) Object.assign(it, { decision: 'approve', note: decision, decidedAt: this.now() });
      if (rv.items.every(i => i.decision)) { rv.status = 'approved'; rv.approvedAt = this.now(); }
      if (decision === 'pause' || decision === 'abandon') this._reviseGoal(tx, goalId, { status: decision === 'pause' ? 'paused' : 'abandoned' }, why);
      else this._reviseGoal(tx, goalId, {}, `re-authored at ${why}`);
    });
    return { status: 'ok', undo, goal: clone(this.get(goalId)) };
  }

  /** Overdue reviews escalate into the queue. Nothing is silently reset. */
  async checkReviews() {
    const out = [];
    for (const cadence of Object.keys(PERIOD_DAYS)) {
      const approved = this.list('review', r => r.cadence === cadence && r.status === 'approved').map(r => r.approvedAt);
      const due = Math.max(this.createdAt, ...approved) + (PERIOD_DAYS[cadence] + this.cfg.reviewGraceDays[cadence]) * DAY;
      if (this.now() <= due) continue;
      const draft = this.list('review', r => r.cadence === cadence && r.status === 'draft')[0];
      out.push(await this._queueNow({
        type: 'review_escalation', dedupKey: `review:${cadence}:${due}`, confidence: 1,
        rationale: `Your ${cadence} review is overdue since ${S.dayKey(due, this.tz)}. Nothing has been reset: ${draft ? `the open draft (${draft.items.filter(i => !i.decision).length} undecided items) carries forward` : 'a draft is ready to generate'}.`,
        payload: { cadence, overdueSince: due, draftId: draft ? draft.id : null },
      }));
    }
    return out;
  }

  // ---------- reminders ----------

  channelsAt(ms) {
    const ch = this.model.preferences.channels || { in_app: { on: true } };
    return Object.entries(ch).filter(([, c]) => c.on && !(c.quiet && !c.quiet.override && this._overlapsDaily(ms, ms + 1, c.quiet))).map(([k]) => k).sort();
  }

  /** Never a bare "you have an event": the goal it serves and where things stand. */
  reminderFor(sessionId, { leadMinutes = 15 } = {}) {
    const s = this.get(sessionId, 'session'), tr = this.trace(sessionId);
    const p = s.practiceId ? this.find(s.practiceId, 'practice') : null;
    const g = tr.goalId ? this.find(tr.goalId, 'goal') : null;
    const last = p ? this.list('session', x => x.practiceId === p.id && x.status === 'done' && x.rpe != null).sort((a, b) => b.start - a.start)[0] : null;
    const r = this._latest('readiness');
    const prior = p ? this.list('session', x => x.practiceId === p.id && (x.missReason || (x.snoozes || []).length)).sort((a, b) => b.start - a.start)[0] : null;
    const stale = !!(g && s.goalVersion != null && s.goalVersion !== g.version);
    const state = {
      topic: p ? p.title : null, mastery: p ? p.mastery : null, readiness: r ? r.payload.score : null,
      lastRpe: last ? last.rpe : null, priorResponse: prior ? prior.missReason || prior.snoozes[prior.snoozes.length - 1].reason : null,
    };
    const lines = [
      `${s.title} at ${S.localLabel(s.start, this.tz)}${s.minutes ? ` (${s.minutes} min; minimum ${this._mvd(s)})` : ''}.`,
      tr.chain.length > 1 ? `For: ${tr.chain.slice(1).map(c => c.title).join(' → ')}.` : 'Unaligned: serves no goal.',
      [state.mastery && `Mastery: ${state.mastery}`, state.readiness != null && `readiness ${state.readiness}`, state.lastRpe != null && `last RPE ${state.lastRpe}`, state.priorResponse && `last time: "${state.priorResponse}"`].filter(Boolean).join(', '),
      stale ? `Planned under v${s.goalVersion} of "${g.title}"; it is now v${g.version}. Still the right session?` : '',
    ].filter(Boolean);
    return clone({ sessionId, text: lines.join(' '), trace: tr.chain, state, staleGoalVersion: stale, channels: this.channelsAt(s.start - leadMinutes * MIN) });
  }

  escalations() {
    const out = [], now = this.now();
    for (const d of this.list('session', s => s.type === 'deadline' && s.status === 'planned' && s.start > now && s.start - now < DAY)) {
      const blocks = this.list('session', s => s.forDeadline === d.id && s.status === 'planned');
      if (!blocks.length) out.push({ kind: 'block_time_now', deadlineId: d.id, text: `"${d.title}" is due ${S.localLabel(d.start, this.tz)} and has no time blocked. Block time now?`, action: 'blockTimeNow' });
    }
    return out;
  }

  async blockTimeNow(deadlineId, minutes = 60) {
    const d = this.get(deadlineId, 'session');
    const slot = await this.nextSlot({ title: `Work on: ${d.title}`, type: 'event', start: this.now(), end: this.now() + minutes * MIN, goalId: d.goalId }, d.domainId);
    if (!slot || slot.end > d.start) return { status: 'no_slot', message: 'No valid slot before the deadline. Something has to move — that is your call.' };
    return this.scheduleSession({ title: `Work on: ${d.title}`, start: slot.start, end: slot.end, goalId: d.goalId || undefined, forDeadline: d.id }, { ackUnaligned: !d.goalId, calendarId: this._primaryCalendar() });
  }

  async snooze(sessionId, reason) {
    if (!reason) throw new EngineError('invalid', 'a snooze needs a reason; it is how reminders learn');
    const { undo } = await this._tx('user', `snoozed: ${reason}`, tx => { tx.edit(sessionId, 'session').snoozes.push({ at: this.now(), reason }); });
    return { status: 'ok', undo };
  }

  // ---------- data lifecycle & observability ----------

  async purgeExpired() {
    const rawCut = this.now() - this.cfg.rawRetentionDays * DAY, grace = this.now() - this.cfg.undoGraceHours * H;
    let rawBodies = 0, softDeleted = 0, undoTokens = 0;
    for (const [id, v] of this.raw) if (v.at < rawCut) { this.raw.delete(id); rawBodies++; } // the signal record stays: metadata only
    for (const r of [...this.rec.values()]) if (r.deletedAt && r.deletedAt < grace) { this.rec.delete(r.id); softDeleted++; }
    for (const [t, u] of this.undos) if (u.at < grace) { this.undos.delete(t); undoTokens++; }
    return { rawBodies, softDeleted, undoTokens };
  }

  export() {
    const by = {};
    for (const r of this.rec.values()) (by[r.kind] = by[r.kind] || []).push(clone(r));
    return {
      format: 'project1pct-export/1', exportedAt: this.now(), userId: this.id, engineVersion: VERSION, signalsVersion: S.VERSION,
      model: clone(this.model), visions: by.vision || [], goals: by.goal || [], milestones: by.milestone || [], practices: by.practice || [],
      sessions: by.session || [], signals: by.signal || [], proposals: by.proposal || [], reviews: by.review || [], patterns: by.pattern || [],
      decisions: (by.proposal || []).filter(p => p.decidedAt || p.status === 'auto_committed').map(p => ({ id: p.id, type: p.type, status: p.status, at: p.decidedAt || p.updatedAt, reason: p.decisionReason || null, edits: p.edits || null })),
      evidenceLog: this.evidenceLog(), modelHistory: this.modelHistory(), audit: clone(this.audit),
      rawBodies: [...this.raw].map(([signalId, v]) => ({ signalId, ...v })),
    };
  }

  /** "Why did this happen?" for any session, proposal, goal or signal. */
  why(id) {
    const r = this.get(id);
    const proposal = r.kind === 'proposal' ? r : r.proposalId ? this.find(r.proposalId) : null;
    const signals = [...new Set([...(proposal ? proposal.signalIds : []), ...(r.signalId ? [r.signalId] : []), ...(r.kind === 'signal' ? [r.id] : [])])].map(s => this.find(s)).filter(Boolean);
    const traces = new Set([r.traceId, proposal && proposal.traceId].filter(Boolean));
    const writes = this.audit.filter(a => a.id === id || (proposal && a.id === proposal.id) || traces.has(a.traceId))
      .map(a => ({ at: a.at, actor: a.actor, op: a.op, kind: a.kind, id: a.id, rationale: a.rationale, undo: a.undo }));
    const goalId = r.kind === 'goal' ? id : proposal && proposal.payload && proposal.payload.alignment ? proposal.payload.alignment.goalId : null;
    const chain = r.kind === 'session' ? this.trace(id).chain : goalId ? this.trace({ goalId }).chain : [];
    const reviews = this.list('review', rv => JSON.stringify(rv.items).includes(`"${id}"`)).map(rv => rv.id);
    const story = [];
    for (const s of signals) story.push(`Triggered by ${s.type} from ${s.source} at ${S.localLabel(s.timestamp, this.tz)}${s.payload.class ? ` (classified ${s.payload.class})` : ''}.`);
    if (proposal) story.push(`Proposal ${proposal.type}, ${proposal.status}, confidence ${proposal.confidence}: ${proposal.rationale}`);
    story.push(chain.length ? `Serves: ${chain.map(c => c.title).join(' → ')}.` : 'Traces to no goal (unaligned).');
    for (const w of writes) story.push(`${S.localLabel(w.at, this.tz)} ${w.actor} ${w.op} ${w.kind}: ${w.rationale}${w.undo ? ` [undo ${w.undo}]` : ''}`);
    return clone({
      id, kind: r.kind, signals: signals.map(s => ({ id: s.id, type: s.type, source: s.source, at: s.timestamp, class: s.payload.class || null })),
      scoring: proposal && proposal.payload ? proposal.payload.alignment || null : null,
      proposal: proposal ? { id: proposal.id, type: proposal.type, status: proposal.status, rationale: proposal.rationale, confidence: proposal.confidence } : null,
      trace: chain, writes, reviews, story,
    });
  }

  /** The daily heartbeat: sweep misses, check reviews, load and development. */
  async tick() {
    return {
      missed: await this.sweepMissed(), reviews: await this.checkReviews(), sustainability: await this.sustainabilityCheck(),
      development: await this.checkDevelopment(), purged: await this.purgeExpired(), escalations: this.escalations(),
    };
  }
}

function dirOf(ind, pts) {
  if (ind.direction === 'down') return -1;
  if (ind.direction === 'up') return 1;
  return Math.sign(ind.target - pts[0].v) || 1;
}

const api = { createEngine, EngineError, DEFAULTS, VERSION, REQUIRED, REELICIT };
if (isNode) module.exports = api; else (root.P1 = root.P1 || {}).engine = api;
})(typeof globalThis === 'object' ? globalThis : this);
