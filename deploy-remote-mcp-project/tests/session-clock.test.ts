import assert from 'node:assert/strict';
import { macroWindows, overlapWindow, localWallToUtc } from '@/vela/sessions/sessionClock';
import { computeSessionSpans, getActiveSessionClock } from '@/vela/sessions/sessionMath';
const W = Date.parse('2026-01-15T00:00:00Z'), S = Date.parse('2026-06-15T00:00:00Z');
const at = (d: number, h: number, m = 0) => d + h * 3600_000 + m * 60_000;
const win = (d: number, mode: 'fixed'|'local', id: string) => macroWindows(d, mode).find(w => w.id === id)!;
assert.equal(win(W,'local','london').startMs, at(W,8));
assert.equal(win(W,'local','london').endMs, at(W,16,30));
assert.equal(win(S,'local','london').startMs, at(S,7));
assert.equal(win(S,'local','london').endMs, at(S,15,30));
assert.equal(win(W,'local','ny').startMs, at(W,13));
assert.equal(win(S,'local','ny').startMs, at(S,12));
assert.equal(win(W,'fixed','london').startMs, at(W,8));
assert.equal(win(S,'fixed','london').startMs, at(S,8));
assert.equal(overlapWindow(macroWindows(W,'local'))!.startMs, at(W,13));
assert.equal(overlapWindow(macroWindows(S,'local'))!.endMs, at(S,15,30));
// Asia range convention stays explicitly fixed UTC in both modes.
assert.equal(win(S,'local','asia').startMs, S); assert.equal(win(S,'local','asia').endMs, at(S,8));
const opts = { mode: 'macro' as const, clockMode: 'local' as const, enabledSessions: { asia:true,london:true,ny:true }, showOverlap:true };
const spans = computeSessionSpans(S, S + 86_400_000, opts);
assert.equal(spans.find(x=>x.id==='london')!.startMs, at(S,7));
assert.equal(getActiveSessionClock(at(S,7,30), 'macro', 'local').activeSessions.some(x=>x.id==='london'), true);
assert.equal(getActiveSessionClock(at(S,7,30), 'macro', 'fixed').activeSessions.some(x=>x.id==='london'), false);
// Local-mode killzone presets and their side-panel rail must use the same fixed windows.
const kzOpts = { mode: 'killzone' as const, clockMode: 'local' as const, enabledSessions: { asia:true,london:true,ny:true }, showOverlap:true };
assert.equal(computeSessionSpans(S, S+86400000, kzOpts).find(x=>x.id==='london')!.startMs, at(S,7));
assert.equal(getActiveSessionClock(at(S,7,30), 'killzone', 'local').windows.find(x=>x.id==='london')!.startMs, at(S,7));
// US 2026 transition: 2026-03-08 02:00 local jumps to 03:00.
assert.equal(localWallToUtc('America/New_York', Date.parse('2026-03-08T00:00:00Z'), 8*60), Date.parse('2026-03-08T12:00:00Z'));
console.log('session-clock: fixed/local conventions, DST boundaries and actual overlap passed');
