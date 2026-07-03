// Multiplayer protocol smoke test against the real RTDB.
// Run: npx tsx scripts/mp-smoke.ts
(globalThis as any).window = { location: { search: "" } };

const { buildAxes } = await import("../src/engine/axes");
const { ENGINES } = await import("../src/engine/engines");
const { baseMaps } = await import("../src/engine/defaults");
const { RaceRoom } = await import("../src/multiplayer/room");

const spec = ENGINES[0];
const axes = buildAxes(spec);
const maps = baseMaps(spec, axes);

const meta = (name: string) => ({
  name,
  engineId: spec.id,
  engineName: spec.name,
  wastegateKpa: 155,
  peakHp: 180,
  ready: false,
  maps,
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (msg: string): never => {
  console.error("FAIL:", msg);
  process.exit(1);
};

console.log("1) host creates room…");
const host = await RaceRoom.host(meta("HostBob"), {}, "test-host-0001");
console.log("   code:", host.code);

console.log("1b) room shows up in the public lobby list…");
const lobbySeen = await new Promise<boolean>((resolve) => {
  const timeout = setTimeout(() => {
    stop();
    resolve(false);
  }, 8000);
  const stop = RaceRoom.watchLobby((list) => {
    if (list.some((e) => e.code === host.code && !e.hasPass)) {
      clearTimeout(timeout);
      stop();
      resolve(true);
    }
  });
});
if (!lobbySeen) fail("hosted room never appeared in the lobby list");
console.log("   listed, unlocked");

console.log("2) guest joins…");
const guest = await RaceRoom.join(host.code, meta("GuestAlice"), "", "test-guest-0002");

console.log("2b) third racer joins (rooms hold up to 8)…");
const third = await RaceRoom.join(host.code, meta("ThirdCarol"), "", "test-third-0003");

await wait(1200);
const seenByHost = host.current;
if (!seenByHost || Object.keys(seenByHost.players).length !== 3)
  fail("host doesn't see 3 players");
console.log("   host sees players:", Object.values(seenByHost!.players).map((p) => p.name).join(", "));

console.log("3) everyone ready…");
await host.setReady(true);
await guest.setReady(true);
await third.setReady(true);
await wait(800);

console.log("3b) guest renames themselves in the lobby…");
await guest.setName("SpeedyAlice");
await wait(800);
const renamed = host.current?.players[guest.myId]?.name;
if (renamed !== "SpeedyAlice") fail(`host sees stale name: ${renamed}`);
console.log("   host sees:", renamed);

console.log("3c) guest swaps engine + retunes in the lobby…");
await guest.updateLoadout({
  engineId: "2jz",
  engineName: "2JZ-GTE — 3.0 I6 twin turbo",
  wastegateKpa: 200,
  peakHp: 310,
  maps,
});
await wait(800);
const g2 = host.current?.players[guest.myId];
if (g2?.engineId !== "2jz" || g2?.peakHp !== 310)
  fail(`host sees stale loadout: ${g2?.engineId} ${g2?.peakHp}`);
if (g2?.ready !== false) fail("loadout change should un-ready the player");
console.log("   host sees:", g2.engineName, `${g2.peakHp} whp, un-readied`);
await guest.setReady(true); // ready back up for the launch check

console.log("4) host launches (green in ~1s for test)…");
await host.launch(1000);
await wait(600);
const gSnap = guest.current;
if (gSnap?.status !== "racing" || typeof gSnap.greenAt !== "number")
  fail("guest didn't see racing status/greenAt");
console.log("   guest sees greenAt (server ms):", gSnap!.greenAt, "offset-adjusted in", (gSnap!.greenAt! - guest.serverNow()).toFixed(0), "ms");

console.log("5) stream live states ~10 Hz for 2s…");
for (let i = 0; i < 20; i++) {
  host.sendLive({ t: i * 0.1, d: i * 2, v: 20, rpm: 4000, gear: 1, blown: false, finished: false });
  guest.sendLive({ t: i * 0.1, d: i * 1.8, v: 18, rpm: 3800, gear: 1, blown: false, finished: false });
  await wait(100);
}
await wait(500);
const hostSeesGuestLive = host.current?.live[guest.myId];
if (!hostSeesGuestLive) fail("host never received guest live state");
console.log("   host sees guest at d =", hostSeesGuestLive!.d.toFixed(1), "m");

console.log("6) results…");
await host.sendResult({ et: 13.412, trapKph: 165, sixtyFt: 2.31, blown: false });
await guest.sendResult({ et: 13.977, trapKph: 160, sixtyFt: 2.4, blown: false });
await third.sendResult({ et: null, trapKph: 0, sixtyFt: null, blown: true });
await wait(800);
const res = guest.current?.results ?? {};
if (Object.keys(res).length !== 3) fail("guest doesn't see all 3 results");
console.log("   all results visible:", Object.values(res).map((r: any) => r.et ?? "DNF").join(" / "));

console.log("7) rematch resets (triggered by a NON-host guest)…");
await guest.rematch();
await wait(800);
const after = host.current;
if (after?.status !== "lobby" || Object.keys(after.results).length !== 0)
  fail("rematch didn't reset room");
if (Object.values(after!.players).some((p) => p.ready)) fail("ready flags not cleared");
console.log("   any driver can bring the room back to the lobby");

console.log("8) guests leave, host sees departures…");
await guest.leave();
await third.leave();
await wait(800);
if (host.opponentIds.length !== 0) fail("host still sees departed racers");
console.log("   host sees empty slots");

console.log("9) host leaves, room deleted…");
await host.leave();
await wait(500);

console.log("10) password-locked rooms…");
const pwHost = await RaceRoom.host(meta("LockBob"), { pass: "hunter2" }, "test-pw-host");
let rejected = false;
try {
  await RaceRoom.join(pwHost.code, meta("Sneaky"), "wrong", "test-pw-bad");
} catch (e) {
  rejected = /password/i.test(String(e));
}
if (!rejected) fail("wrong password was accepted");
console.log("   wrong password rejected");
const pwGuest = await RaceRoom.join(pwHost.code, meta("Friend"), "hunter2", "test-pw-good");
await wait(800);
if (pwHost.opponentIds.length !== 1) fail("correct password join failed");
console.log("   correct password accepted");
await pwGuest.leave();
await pwHost.leave();

console.log("\nMP SMOKE OK");
process.exit(0);
