// Called by playback-smoke.py. The token is read from stdin and never logged.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  const { origin, jobId, token } = JSON.parse(fs.readFileSync(0, 'utf8'));
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const devtools = await context.newCDPSession(page);
    const responses = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.name));
    page.on('response', response => {
      const url = new URL(response.url());
      if (!['http:', 'https:'].includes(url.protocol)) return;
      responses.push({ path: url.pathname, status: response.status(), origin: url.origin });
    });
    await page.goto(origin + '/player/');
    await page.evaluate(() => {
      window.playbackEvidence = { usable: false, frames: 0 };
      const createSession = MediaKeys.prototype.createSession;
      MediaKeys.prototype.createSession = function (...args) {
        const session = createSession.apply(this, args);
        session.addEventListener('keystatuseschange', () => {
          window.playbackEvidence.usable ||= [...session.keyStatuses.values()].includes('usable');
        });
        return session;
      };
      const video = document.querySelector('video');
      const frame = () => {
        if (video.mediaKeys && window.playbackEvidence.usable) window.playbackEvidence.frames++;
        video.requestVideoFrameCallback(frame);
      };
      video.requestVideoFrameCallback(frame);
    });
    await page.locator('#token').fill(token).catch(() => { throw Error('Viewer token field unavailable'); });
    await page.locator('#job').fill(jobId);
    await page.locator('#connectBtn').click();
    const startPlayback = await page.waitForFunction(() => {
      const video = document.querySelector('video');
      if (!video.mediaKeys || document.querySelector('#connectBtn').disabled) return false;
      return video.paused ? 'click' : 'playing';
    }, null, { timeout: 20000 }).catch(async () => {
      throw Error('Lesson failed to load: ' + await page.locator('#liveStatus').innerText() +
        ' ' + JSON.stringify({ responses, errors }));
    });
    if (await startPlayback.jsonValue() === 'click') await page.locator('#heroPlay').click();
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      return video.mediaKeys && video.currentTime > 1 &&
        window.playbackEvidence.usable && window.playbackEvidence.frames >= 4;
    }, null, { timeout: 30000 }).catch(async () => {
      const evidence = await page.evaluate(() => {
        const v = document.querySelector('video');
        return { ...window.playbackEvidence, time: v.currentTime, mediaError: v.error?.code };
      });
      throw Error('Playback timed out ' + JSON.stringify({ evidence, responses, errors }));
    });
    assert.equal(errors.length, 0, 'Unhandled browser error');
    assert(responses.every(r => r.origin === origin), 'Hosted player made an off-origin request');
    assert(responses.some(r => r.status === 200 && r.path.endsWith('.mpd')), 'No DASH manifest response');
    for (const track of ['audio.mp4', 'video.mp4']) {
      assert(responses.some(r => r.status === 206 && r.path.endsWith('/' + track)),
        'No ranged response for ' + track);
    }
    assert(responses.some(r => r.status === 200 && r.path.includes('/license')), 'No license response');
    const observed = await page.evaluate(() => ({
      frames: window.playbackEvidence.frames,
      seconds: document.querySelector('video').currentTime.toFixed(2),
      audioBytes: document.querySelector('video').webkitAudioDecodedByteCount,
    }));
    await page.locator('#autoPrivacy').check();
    // Playwright emulates focus when a page navigates. Restore native tab focus here.
    await devtools.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await page.evaluate(() => {
      window.addEventListener('blur', e => { window.playbackEvidence.nativeBlur = e.isTrusted; },
        { once: true });
    });
    const otherTab = await context.newPage();
    await otherTab.bringToFront();
    await page.waitForFunction(() => {
      const curtain = document.querySelector('#privacyCurtain');
      return window.playbackEvidence.nativeBlur && document.querySelector('#stage').hasAttribute('data-masked') &&
        !curtain.hidden && getComputedStyle(curtain).backgroundColor === 'rgb(0, 0, 0)' &&
        document.querySelector('#preview').paused &&
        getComputedStyle(document.querySelector('#preview')).visibility === 'hidden';
    }, null, { timeout: 5000, polling: 100 }).catch(async () => {
      const state = await page.evaluate(() => ({
        focus: document.hasFocus(), optIn: document.querySelector('#autoPrivacy').checked,
        masked: document.querySelector('#stage').hasAttribute('data-masked'),
        hidden: document.querySelector('#privacyCurtain').hidden,
        visibility: getComputedStyle(document.querySelector('#preview')).visibility,
        paused: document.querySelector('#preview').paused,
      }));
      throw Error('Privacy mask failed during tab switch: ' + JSON.stringify(state));
    });
    await page.bringToFront();
    assert(await page.locator('#privacyCurtain').isVisible(), 'Refocusing revealed protected video');
    const pausedTime = await page.locator('#preview').evaluate(video => video.currentTime);
    await page.locator('#privacyToggle').click();
    assert(await page.locator('#preview').evaluate(video => video.paused),
      'Revealing automatically restarted playback');
    await page.locator('#heroPlay').click();
    await page.waitForFunction(time => document.querySelector('#preview').currentTime > time + 0.2,
      pausedTime, { timeout: 5000 }).catch(() => { throw Error('Video failed to resume after privacy mask'); });
    console.log('Live privacy verified: tab blur masked and paused, refocus stayed masked, manual reveal and resume worked');
    console.log('Browser verified usable EME key, manifest, media ranges, license and ' +
      observed.frames + ' presented frames over ' + observed.seconds + 's' +
      (observed.audioBytes > 0 ? ' and ' + observed.audioBytes + ' decoded audio bytes' : ''));
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
