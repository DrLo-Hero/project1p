'use strict';
// Calendar provider contract, an in-memory reference adapter, and the conformance
// suites every calendar adapter and every signal source must pass before the engine
// is pointed at it. A Google/Microsoft adapter is "done" when calendarConformance
// returns all-ok against a test calendar — not before.
//
// Contract (all async):
//   id, readOnly
//   list({from,to})                -> Event[] (series, not instances)
//   get(id) / findByUid(uid)       -> Event | null
//   create(event)                  -> Event            (duplicate uid -> 'duplicate')
//   update(id, patch, {etag, scope: 'this'|'following'|'series', instance}) -> Event
//   delete(id, {etag, scope, instance}) -> Event | null
//   respond(id, rsvp)              -> Event            (needs_action|accepted|declined|tentative)
//   freeBusy({from,to})            -> [{start,end,status:'busy'|'tentative',type,location,eventId,title}]
//   revoke()                       -> drop stored credentials
// Errors are ProviderError with code: read_only | conflict (carries .remote) |
//   not_found | duplicate | invalid | unavailable | quota.
// Event: {id, uid, title, start, end, tz, rrule, exdates, overrides, rsvp, status,
//   transparency, type: 'default'|'focus'|'ooo'|'working_location', location, etag}

(function (root) {
'use strict';
const isNode = typeof module === 'object' && !!module.exports;
const S = isNode ? require('./signals.js') : root.P1.signals;

class ProviderError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

const RSVP = ['needs_action', 'accepted', 'declined', 'tentative'];
const copy = v => (v == null ? null : structuredClone(v));

class MemoryCalendar {
  constructor({ id = 'memory', readOnly = false } = {}) {
    Object.assign(this, { id, readOnly, events: new Map(), etags: 0, ids: 0, down: false, quota: false, revoked: false });
  }
  dump() { return { id: this.id, readOnly: this.readOnly, etags: this.etags, ids: this.ids, events: [...this.events.values()].map(copy) }; }
  static restore(d) {
    const c = new MemoryCalendar(d);
    Object.assign(c, { etags: d.etags, ids: d.ids, events: new Map(d.events.map(e => [e.id, copy(e)])) });
    return c;
  }
  _check(write, op) {
    if (this.down) throw new ProviderError('unavailable', `${this.id} is unreachable`);
    if (this.quota) throw new ProviderError('quota', `${this.id} quota exhausted`);
    if (write && this.readOnly) throw new ProviderError('read_only', `calendar "${this.id}" is read-only: ${op} needs write access to this calendar`, { scope: this.id, op });
  }
  _save(e) { e.etag = `${this.id}-e${++this.etags}`; this.events.set(e.id, e); return copy(e); }
  _must(id, etag) {
    const e = this.events.get(id);
    if (!e) throw new ProviderError('not_found', `event ${id} not found on ${this.id}`);
    if (etag && etag !== e.etag) throw new ProviderError('conflict', `event ${id} changed on ${this.id} since you last read it`, { remote: copy(e) });
    return e;
  }
  async list({ from = -Infinity, to = Infinity } = {}) {
    this._check(false);
    return [...this.events.values()].filter(e => S.expand(e, { from, to, max: 1 }).length).map(copy);
  }
  async get(id) { this._check(false); return copy(this.events.get(id)); }
  async findByUid(uid) { this._check(false); return copy([...this.events.values()].find(e => e.uid === uid)); }
  async create(ev) {
    this._check(true, 'create');
    if (ev.uid && [...this.events.values()].some(e => e.uid === ev.uid)) throw new ProviderError('duplicate', `uid ${ev.uid} already exists on ${this.id}`);
    const id = `${this.id}:${++this.ids}`;
    return this._save({
      type: 'default', status: 'confirmed', transparency: 'opaque', rsvp: 'accepted', tz: 'UTC',
      rrule: null, location: null, ...copy(ev), exdates: [...(ev.exdates || [])], overrides: { ...(ev.overrides || {}) }, id, uid: ev.uid || id,
    });
  }
  async update(id, patch, { etag, scope = 'series', instance } = {}) {
    this._check(true, 'update');
    const e = this._must(id, etag);
    const { id: _i, etag: _e, ...clean } = copy(patch);
    if (scope === 'this') { e.overrides[instance] = { ...(e.overrides[instance] || {}), ...clean }; return this._save(e); }
    if (scope === 'following') {
      const r = S.parseRRule(e.rrule);
      const before = S.expand({ ...e, exdates: [] }, { to: instance }).length;
      let rrule = String(e.rrule).split(';').filter(p => !/^(UNTIL|COUNT)=/i.test(p)).join(';');
      if (r.COUNT) rrule += `;COUNT=${+r.COUNT - before}`;
      else if (r.UNTIL) rrule += `;UNTIL=${r.UNTIL}`;
      const dur = e.end - e.start;
      const next = { ...copy(e), ...clean, rrule, start: clean.start ?? instance, end: clean.end ?? (clean.start ?? instance) + dur, uid: `${e.uid}_R${instance}`, overrides: {}, exdates: e.exdates.filter(x => x >= instance) };
      delete next.id; delete next.etag;
      e.rrule = S.withUntil(e.rrule, instance - 1000);
      e.exdates = e.exdates.filter(x => x < instance);
      this._save(e);
      return this.create(next);
    }
    Object.assign(e, clean);
    return this._save(e);
  }
  async delete(id, { etag, scope = 'series', instance } = {}) {
    this._check(true, 'delete');
    const e = this._must(id, etag);
    if (scope === 'this') { e.exdates.push(instance); return this._save(e); }
    if (scope === 'following') { e.rrule = S.withUntil(e.rrule, instance - 1000); return this._save(e); }
    this.events.delete(id);
    return null;
  }
  async respond(id, rsvp) {
    this._check(true, 'respond');
    if (!RSVP.includes(rsvp)) throw new ProviderError('invalid', `rsvp must be one of ${RSVP.join(', ')}`);
    const e = this._must(id);
    e.rsvp = rsvp;
    return this._save(e);
  }
  async freeBusy({ from, to }) {
    this._check(false);
    const out = [];
    for (const e of this.events.values()) {
      if (e.status === 'cancelled' || e.rsvp === 'declined') continue;
      if (e.type === 'default' && e.transparency === 'transparent') continue;
      const tentative = e.status === 'tentative' || e.rsvp === 'tentative';
      for (const i of S.expand(e, { from, to })) {
        out.push({ start: i.start, end: i.end, status: tentative ? 'tentative' : 'busy', type: e.type, location: e.location || null, eventId: e.id, title: e.title });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }
  async revoke() { this.revoked = true; }
  /** Test hook: an edit made on the provider side (another device, the web UI). */
  _remoteEdit(id, patch) { const e = this.events.get(id); Object.assign(e, patch); return this._save(e); }
}

// ---------- conformance ----------

async function run(checks) {
  const results = [];
  for (const [name, fn] of checks) {
    try { await fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: e.message }); }
  }
  return results;
}
const assert = (c, m) => { if (!c) throw new Error(m); };
async function rejects(p, code) {
  try { await p; } catch (e) { assert(e.code === code, `expected ${code}, got ${e.code}: ${e.message}`); return e; }
  throw new Error(`expected ${code}, but it succeeded`);
}

/** make({readOnly}) -> a fresh, empty adapter. */
async function calendarConformance(make) {
  const H = 3600e3, W = 7 * 24 * H;
  const base = Date.UTC(2026, 10, 2, 14); // Mon 2 Nov 2026 09:00 New York (EST)
  const ev = (o = {}) => ({ title: 'Check', start: base, end: base + H, tz: 'America/New_York', ...o });
  return run([
    ['create/get round-trips fields', async () => {
      const c = make({});
      const e = await c.create(ev({ uid: 'u1', location: 'Room 4' }));
      const g = await c.get(e.id);
      assert(g.title === 'Check' && g.start === base && g.end === base + H && g.uid === 'u1' && g.location === 'Room 4', 'fields lost');
      assert(g.etag, 'no etag');
    }],
    ['findByUid finds, duplicate uid is rejected', async () => {
      const c = make({});
      const e = await c.create(ev({ uid: 'dup' }));
      assert((await c.findByUid('dup')).id === e.id, 'findByUid missed');
      await rejects(c.create(ev({ uid: 'dup' })), 'duplicate');
    }],
    ['update with current etag changes the etag', async () => {
      const c = make({});
      const e = await c.create(ev());
      const u = await c.update(e.id, { title: 'Moved' }, { etag: e.etag });
      assert(u.etag !== e.etag && u.title === 'Moved', 'etag not bumped');
    }],
    ['update with a stale etag is a conflict carrying the remote copy', async () => {
      const c = make({});
      const e = await c.create(ev());
      await c.update(e.id, { title: 'Theirs' }, { etag: e.etag });
      const err = await rejects(c.update(e.id, { title: 'Mine' }, { etag: e.etag }), 'conflict');
      assert(err.remote && err.remote.title === 'Theirs', 'conflict without remote copy');
    }],
    ['read-only calendar rejects every write with a scope-specific error', async () => {
      const c = make({ readOnly: true });
      for (const p of [c.create(ev()), c.update('x', {}), c.delete('x'), c.respond('x', 'accepted')]) {
        const err = await rejects(p, 'read_only');
        assert(err.scope && err.message.includes(err.scope), 'error does not name the calendar');
      }
    }],
    ['delete removes the event', async () => {
      const c = make({});
      const e = await c.create(ev());
      await c.delete(e.id);
      assert((await c.get(e.id)) === null && !(await c.list({})).length, 'still there');
    }],
    ['scope "this" changes one instance only', async () => {
      const c = make({});
      const e = await c.create(ev({ rrule: 'FREQ=WEEKLY;COUNT=4' }));
      await c.update(e.id, { start: base + W + H, end: base + W + 2 * H }, { scope: 'this', instance: base + W });
      const fb = await c.freeBusy({ from: base, to: base + 4 * W });
      assert(fb.length === 4 && fb[1].start === base + W + H && fb[2].start === base + 2 * W, JSON.stringify(fb.map(f => f.start)));
    }],
    ['scope "following" splits the series', async () => {
      const c = make({});
      const e = await c.create(ev({ rrule: 'FREQ=WEEKLY;COUNT=4' }));
      await c.update(e.id, { title: 'Later' }, { scope: 'following', instance: base + 2 * W });
      const fb = await c.freeBusy({ from: base, to: base + 5 * W });
      assert(fb.length === 4, `expected 4 instances, got ${fb.length}`);
      assert(fb.map(f => f.title).join() === 'Check,Check,Later,Later', fb.map(f => f.title).join());
    }],
    ['deleting one instance leaves the series', async () => {
      const c = make({});
      const e = await c.create(ev({ rrule: 'FREQ=WEEKLY;COUNT=3' }));
      await c.delete(e.id, { scope: 'this', instance: base + W });
      const fb = await c.freeBusy({ from: base, to: base + 4 * W });
      assert(fb.length === 2 && fb[1].start === base + 2 * W, 'instance delete wrong');
    }],
    ['free/busy: tentative is tentative, focus/ooo are typed, transparent is free', async () => {
      const c = make({});
      await c.create(ev({ status: 'tentative' }));
      await c.create(ev({ start: base + 2 * H, end: base + 3 * H, type: 'focus' }));
      await c.create(ev({ start: base + 4 * H, end: base + 5 * H, transparency: 'transparent' }));
      const fb = await c.freeBusy({ from: base, to: base + 6 * H });
      assert(fb.length === 2 && fb[0].status === 'tentative' && fb[1].type === 'focus', JSON.stringify(fb));
    }],
    ['RSVP states are first-class and validated', async () => {
      const c = make({});
      const e = await c.create(ev());
      for (const s of RSVP) assert((await c.respond(e.id, s)).rsvp === s, `rsvp ${s}`);
      await rejects(c.respond(e.id, 'maybe'), 'invalid');
    }],
    ['DST: a weekly 09:00 keeps wall-clock across the change', async () => {
      const c = make({});
      const oct26 = Date.UTC(2026, 9, 26, 13); // 09:00 EDT
      await c.create(ev({ start: oct26, end: oct26 + H, rrule: 'FREQ=WEEKLY;COUNT=2' }));
      const fb = await c.freeBusy({ from: oct26, to: oct26 + 2 * W });
      assert(fb[1].start === base, `second instance at ${new Date(fb[1].start).toISOString()}, want 14:00Z`);
    }],
  ]);
}

/** source: { id, fetch({since}) -> Signal[] }. Must be valid, unique and stable. */
async function sourceConformance(source) {
  return run([
    ['every signal meets the contract', async () => {
      for (const s of await source.fetch({})) { const errs = S.validateSignal(s); assert(!errs.length, `${s.idempotencyKey}: ${errs.join(', ')}`); }
    }],
    ['idempotency keys are unique within a fetch', async () => {
      const keys = (await source.fetch({})).map(s => s.idempotencyKey);
      assert(new Set(keys).size === keys.length, 'duplicate keys');
    }],
    ['re-fetching yields the same keys and payloads', async () => {
      const strip = list => JSON.stringify(list.map(s => ({ ...s, payload: { ...s.payload, meta: null } })));
      assert(strip(await source.fetch({})) === strip(await source.fetch({})), 'not deterministic');
    }],
  ]);
}

const api = { ProviderError, MemoryCalendar, RSVP, calendarConformance, sourceConformance };
if (isNode) module.exports = api; else (root.P1 = root.P1 || {}).calendar = api;
})(typeof globalThis === 'object' ? globalThis : this);
