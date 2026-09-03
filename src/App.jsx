import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from './supabaseClient.js';
import MonthGrid from './components/MonthGrid.jsx';
import DaySheet from './components/DaySheet.jsx';
import StaffPanel from './components/StaffPanel.jsx';
import { ChevronLeft, ChevronRight, Users, LogOut, CalendarIcon } from './components/Icons.jsx';
import { monthLabel, monthRange } from './utils.js';

/* ------------------------------------------------------------------ */
/* Sign in                                                             */
/* ------------------------------------------------------------------ */

function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setBusy(true);
    setError('');
    const { error: err } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setBusy(false);
    if (err) setError('That email and password did not match. Check them and try again.');
  }

  return (
    <div className="signin-wrap">
      <div className="signin">
        <h1>Pharmacist coverage</h1>
        <p>Sign in to see who is working where.</p>

        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') signIn();
            }}
          />
        </div>

        {error && <div className="error">{error}</div>}

        <button className="btn" style={{ marginTop: 12 }} onClick={signIn} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

export default function App() {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);

  const [me, setMe] = useState(null);
  const [locations, setLocations] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [shifts, setShifts] = useState([]);

  const [viewDate, setViewDate] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState(null);
  const [mineOnly, setMineOnly] = useState(false);
  const [locationFilter, setLocationFilter] = useState('all');
  const [showStaff, setShowStaff] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');

  /* ---------- session ---------- */

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  /* ---------- who am I, stores, people ---------- */

  const loadCore = useCallback(async () => {
    if (!session) return;
    const [meRes, locRes, profRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle(),
      supabase.from('locations').select('*').eq('active', true).order('sort_order'),
      supabase.from('profiles').select('*').order('full_name'),
    ]);
    if (meRes.error || locRes.error || profRes.error) {
      setLoadError('The schedule could not load. Pull down to refresh, or try signing out and back in.');
      return;
    }
    setLoadError('');
    setMe(meRes.data);
    setLocations(locRes.data || []);
    setProfiles(profRes.data || []);
  }, [session]);

  useEffect(() => {
    loadCore();
  }, [loadCore]);

  /* ---------- shifts for the visible month ---------- */

  const range = useMemo(() => monthRange(viewDate), [viewDate]);

  const loadShifts = useCallback(async () => {
    if (!session) return;
    const { data, error } = await supabase
      .from('shifts')
      .select('*')
      .gte('shift_date', range.from)
      .lte('shift_date', range.to);
    if (error) {
      setLoadError('The schedule could not load. Check your connection and try again.');
      return;
    }
    setLoadError('');
    setShifts(data || []);
  }, [session, range.from, range.to]);

  useEffect(() => {
    loadShifts();
  }, [loadShifts]);

  /* ---------- derived ---------- */

  const isManager = me?.role === 'manager';

  const locationsById = useMemo(
    () => Object.fromEntries(locations.map((l) => [l.id, l])),
    [locations]
  );

  const profilesById = useMemo(
    () => Object.fromEntries(profiles.map((p) => [p.id, p])),
    [profiles]
  );

  const visibleShifts = useMemo(() => {
    return shifts.filter((s) => {
      if (mineOnly && s.pharmacist_id !== session?.user?.id) return false;
      if (locationFilter !== 'all' && s.location_id !== locationFilter) return false;
      return true;
    });
  }, [shifts, mineOnly, locationFilter, session]);

  const shiftsByDate = useMemo(() => {
    const map = {};
    for (const s of visibleShifts) {
      (map[s.shift_date] ||= []).push(s);
    }
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => {
        const oa = locationsById[a.location_id]?.sort_order ?? 99;
        const ob = locationsById[b.location_id]?.sort_order ?? 99;
        if (oa !== ob) return oa - ob;
        return String(a.start_time).localeCompare(String(b.start_time));
      });
    }
    return map;
  }, [visibleShifts, locationsById]);

  const activeProfiles = useMemo(() => profiles.filter((p) => p.active), [profiles]);

  /* ---------- actions ---------- */

  async function saveShift(shift) {
    setSaving(true);
    const payload = {
      shift_date: shift.shift_date,
      location_id: shift.location_id,
      pharmacist_id: shift.pharmacist_id,
      start_time: shift.start_time,
      end_time: shift.end_time,
      notes: shift.notes,
      created_by: session.user.id,
    };
    const query = shift.id
      ? supabase.from('shifts').update(payload).eq('id', shift.id)
      : supabase.from('shifts').insert(payload);
    const { error } = await query;
    setSaving(false);
    if (error) return false;
    await loadShifts();
    return true;
  }

  async function deleteShift(id) {
    const { error } = await supabase.from('shifts').delete().eq('id', id);
    if (!error) await loadShifts();
  }

  async function saveProfile(p) {
    const { error } = await supabase
      .from('profiles')
      .update({ full_name: p.full_name, initials: p.initials, role: p.role, active: p.active })
      .eq('id', p.id);
    if (error) return false;
    await loadCore();
    return true;
  }

  function shiftMonth(delta) {
    setViewDate((d) => new Date(d.getFullYear(), d.getMonth() + delta, 1));
  }

  /* ---------- render ---------- */

  if (!ready) return null;
  if (!session) return <SignIn />;

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>Pharmacist coverage</h1>
          <div className="sub">{me ? me.full_name : 'Loading…'}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {isManager && (
            <button className="icon-btn" onClick={() => setShowStaff(true)} aria-label="Pharmacists">
              <Users />
            </button>
          )}
          <button
            className="icon-btn"
            onClick={() => supabase.auth.signOut()}
            aria-label="Sign out"
          >
            <LogOut />
          </button>
        </div>
      </header>

      <div className="month-bar">
        <button className="icon-btn" onClick={() => shiftMonth(-1)} aria-label="Previous month">
          <ChevronLeft />
        </button>
        <div className="month-title">{monthLabel(viewDate)}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="icon-btn" onClick={() => setViewDate(new Date())} aria-label="This month">
            <CalendarIcon />
          </button>
          <button className="icon-btn" onClick={() => shiftMonth(1)} aria-label="Next month">
            <ChevronRight />
          </button>
        </div>
      </div>

      <div className="toggle-row">
        <button
          className={`chip-btn${mineOnly ? ' on' : ''}`}
          onClick={() => setMineOnly((v) => !v)}
        >
          My shifts
        </button>
        <button
          className={`chip-btn${locationFilter === 'all' ? ' on' : ''}`}
          onClick={() => setLocationFilter('all')}
        >
          All stores
        </button>
        {locations.map((l) => (
          <button
            key={l.id}
            className={`chip-btn${locationFilter === l.id ? ' on' : ''}`}
            onClick={() => setLocationFilter(l.id)}
          >
            {l.abbrev}
          </button>
        ))}
      </div>

      <div className="legend">
        {locations.map((l) => (
          <span key={l.id}>
            <span className="dot" style={{ background: l.color }} />
            {l.name}
          </span>
        ))}
      </div>

      {loadError && <div className="error" style={{ marginBottom: 10 }}>{loadError}</div>}

      <MonthGrid
        viewDate={viewDate}
        shiftsByDate={shiftsByDate}
        locationsById={locationsById}
        profilesById={profilesById}
        onSelectDate={setSelectedDate}
        showGaps={!mineOnly && locationFilter === 'all'}
        locationCount={locations.length}
      />

      {selectedDate && (
        <DaySheet
          dateKey={selectedDate}
          shifts={shiftsByDate[selectedDate] || []}
          locations={locations}
          profiles={activeProfiles}
          isManager={isManager}
          saving={saving}
          onClose={() => setSelectedDate(null)}
          onSave={saveShift}
          onDelete={deleteShift}
        />
      )}

      {showStaff && (
        <StaffPanel
          profiles={profiles}
          onClose={() => setShowStaff(false)}
          onSave={saveProfile}
        />
      )}
    </div>
  );
}
