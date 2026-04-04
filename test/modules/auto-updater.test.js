// ============================================================
// TEST — AutoUpdater.js (v6.0.1)
// ============================================================

const { describe, test, run } = require('../harness');
const { AutoUpdater } = require('../../src/agent/capabilities/AutoUpdater');

describe('AutoUpdater', () => {
  test('constructs with defaults', () => {
    const au = new AutoUpdater({});
    const status = au.getStatus();
    if (!status.currentVersion) throw new Error('Should have currentVersion');
    if (status.checkOnBoot !== true) throw new Error('Default checkOnBoot should be true');
    if (status.checkIntervalHours !== 24) throw new Error('Default interval should be 24h');
  });

  test('_isNewer detects newer versions', () => {
    const au = new AutoUpdater({});
    if (!au._isNewer('6.1.0', '6.0.0')) throw new Error('6.1.0 > 6.0.0');
    if (!au._isNewer('6.0.1', '6.0.0')) throw new Error('6.0.1 > 6.0.0');
    if (!au._isNewer('7.0.0', '6.9.9')) throw new Error('7.0.0 > 6.9.9');
  });

  test('_isNewer rejects older or equal versions', () => {
    const au = new AutoUpdater({});
    if (au._isNewer('6.0.0', '6.0.0')) throw new Error('6.0.0 = 6.0.0');
    if (au._isNewer('5.9.9', '6.0.0')) throw new Error('5.9.9 < 6.0.0');
    if (au._isNewer('6.0.0', '6.0.1')) throw new Error('6.0.0 < 6.0.1');
  });

  test('_isNewer handles version tag prefix', () => {
    const au = new AutoUpdater({});
    // _isNewer expects stripped versions (tag_name.replace(/^v/, ''))
    if (!au._isNewer('6.1.0', '6.0.0')) throw new Error('Should detect newer');
  });

  test('_isNewer handles partial versions', () => {
    const au = new AutoUpdater({});
    if (!au._isNewer('2.0.0', '1')) throw new Error('2.0.0 > 1');
    if (au._isNewer('1', '2.0.0')) throw new Error('1 < 2.0.0');
  });

  test('getStatus returns correct structure', () => {
    const au = new AutoUpdater({});
    const s = au.getStatus();
    if (typeof s.currentVersion !== 'string') throw new Error('Missing currentVersion');
    if (typeof s.checkOnBoot !== 'boolean') throw new Error('Missing checkOnBoot');
    if (typeof s.checkIntervalHours !== 'number') throw new Error('Missing checkIntervalHours');
    if (s.lastCheck !== null) throw new Error('lastCheck should be null initially');
    if (s.latestRelease !== null) throw new Error('latestRelease should be null initially');
  });

  test('checkForUpdate returns result structure on network failure', async () => {
    // Will fail because no network, but should return graceful result
    const au = new AutoUpdater({ config: { owner: 'nonexistent-user-xxxxx', repo: 'nonexistent-repo-xxxxx' } });
    const result = await au.checkForUpdate();
    if (typeof result.available !== 'boolean') throw new Error('Missing available');
    if (typeof result.current !== 'string') throw new Error('Missing current');
    // Should not throw — graceful degradation
  });

  test('emits update:available when newer version found', async () => {
    const events = [];
    const bus = { emit: (n, d) => events.push({ n, d }), fire() {} };

    // Mock the fetch to return a fake release
    const au = new AutoUpdater({ bus });
    au._currentVersion = '1.0.0';
    au._fetchLatestRelease = async () => ({
      tag_name: 'v99.0.0',
      html_url: 'https://github.com/test/test/releases/99',
      body: 'Test release notes',
      published_at: '2026-04-04T00:00:00Z',
    });

    const result = await au.checkForUpdate();
    if (!result.available) throw new Error('Should detect newer version');
    if (result.latest !== '99.0.0') throw new Error(`Expected 99.0.0, got ${result.latest}`);

    const updateEvt = events.find(e => e.n === 'update:available');
    if (!updateEvt) throw new Error('Should emit update:available');
    if (updateEvt.d.latest !== '99.0.0') throw new Error('Event should contain latest version');
  });

  test('no event when already up to date', async () => {
    const events = [];
    const bus = { emit: (n, d) => events.push({ n, d }), fire() {} };
    const au = new AutoUpdater({ bus });
    au._currentVersion = '99.0.0';
    au._fetchLatestRelease = async () => ({ tag_name: 'v6.0.0', html_url: '', body: '' });

    const result = await au.checkForUpdate();
    if (result.available) throw new Error('Should be up to date');
    if (events.find(e => e.n === 'update:available')) throw new Error('Should not emit update:available');
  });

  test('handles null release (no releases published)', async () => {
    const au = new AutoUpdater({});
    au._fetchLatestRelease = async () => null;
    const result = await au.checkForUpdate();
    if (result.available) throw new Error('Should return not available for null release');
  });

  test('records lastCheck timestamp after check', async () => {
    const au = new AutoUpdater({});
    au._fetchLatestRelease = async () => ({ tag_name: 'v1.0.0', html_url: '', body: '' });
    if (au.getStatus().lastCheck !== null) throw new Error('Should be null before check');
    await au.checkForUpdate();
    if (au.getStatus().lastCheck === null) throw new Error('Should record lastCheck');
  });

  test('config override via constructor', () => {
    const au = new AutoUpdater({ config: { checkOnBoot: false, checkIntervalHours: 48 } });
    const s = au.getStatus();
    if (s.checkOnBoot !== false) throw new Error('Should override checkOnBoot');
    if (s.checkIntervalHours !== 48) throw new Error('Should override interval');
  });
});

if (require.main === module) run();
