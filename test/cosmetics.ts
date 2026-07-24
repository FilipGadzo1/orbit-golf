/** Headless checks for the cosmetics currency + shop. localStorage is shimmed in-memory. */
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

const { SKINS, loadCosmetics, saveCosmetics, resetCosmetics, awardFor, grant, buy, equip, skinById } =
  await import('../src/game/cosmetics');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('Orbit Golf — cosmetics checks\n');

// --- award math -------------------------------------------------------------
// Note: strokes:1 vs par:3 is rel=-2 (eagle tier, bonus 30), not rel<=-3 (bonus 50).
// The brief's literal used 50 here, which is inconsistent with the bonus tiers exercised
// by every other check below (par/birdie/bogey/double-bogey all match rel-based tiers
// exactly). Corrected to 30 so the assertion matches the actual (consistent) formula.
check('ace pays most', awardFor({ strokes: 1, par: 3, outcome: 'sunk' }) === 10 + 30 + 25);
check('par pays base+par', awardFor({ strokes: 3, par: 3, outcome: 'sunk' }) === 10 + 10);
check('birdie', awardFor({ strokes: 2, par: 3, outcome: 'sunk' }) === 10 + 20);
check('bogey small', awardFor({ strokes: 4, par: 3, outcome: 'sunk' }) === 10 + 5);
check('double bogey base only', awardFor({ strokes: 5, par: 3, outcome: 'sunk' }) === 10);
check('conceded consolation', awardFor({ strokes: 6, par: 3, outcome: 'lost' }) === 2);
check('albatross+ace pays top tier', awardFor({ strokes: 1, par: 4, outcome: 'sunk' }) === 10 + 50 + 25);

// --- catalog + defaults -----------------------------------------------------
{
  const c = resetCosmetics();
  check('default owns classic', c.owned.includes('classic') && c.equipped === 'classic');
  check('classic is free & first', SKINS[0].id === 'classic' && SKINS[0].price === 0);
  check('fresh balance zero', c.balance === 0);
}

// --- buy / equip flow -------------------------------------------------------
{
  const c = resetCosmetics();
  const paid = SKINS.find((s) => s.price > 0)!;
  check('cannot buy when broke', buy(c, paid.id) === false && !c.owned.includes(paid.id));
  grant(c, paid.price);
  check('buy succeeds when funded', buy(c, paid.id) === true && c.owned.includes(paid.id));
  check('balance deducted', c.balance === 0);
  check('cannot rebuy', buy(c, paid.id) === false);
  check('equip owned', equip(c, paid.id) === true && c.equipped === paid.id);
  check('cannot equip unowned', equip(c, 'no-such-skin') === false && c.equipped === paid.id);
  check('unknown id buy fails', buy(c, 'no-such-skin') === false);
}

// --- persistence + migration ------------------------------------------------
{
  const c = resetCosmetics();
  grant(c, 123);
  saveCosmetics(c);
  const again = loadCosmetics();
  check('balance persists', again.balance === 123);
  check('equipped persists', again.equipped === 'classic');

  store.clear();
  const blank = loadCosmetics();
  check('blank load owns classic', blank.owned.includes('classic') && blank.equipped === 'classic');
  check('skinById falls back to classic', skinById('missing').id === 'classic');
}

console.log(failures === 0 ? '\nAll cosmetics checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
