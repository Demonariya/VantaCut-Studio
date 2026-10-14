import { expect, test, type Page } from '@playwright/test'
import { readdirSync, readFile } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

async function makeVideo(page: Page, frameCount = 72) {
  return page.evaluate(async (frameCount) => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 180
    const context = canvas.getContext('2d')
    if (!context || !MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')) {
      throw new Error('This browser cannot encode a WebM video with an Opus audio stream.')
    }
    const audioContext = new AudioContext()
    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()
    const audioDestination = audioContext.createMediaStreamDestination()
    gain.gain.value = 0.15
    oscillator.frequency.value = 440
    oscillator.connect(gain).connect(audioDestination)
    oscillator.start()
    const stream = canvas.captureStream(24)
    audioDestination.stream.getAudioTracks().forEach((track) => stream.addTrack(track))
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' })
    const chunks: BlobPart[] = []
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
    const finished = new Promise<void>((resolve, reject) => {
      recorder.onstop = () => resolve()
      recorder.onerror = () => reject(new Error('Could not record the local WebM test fixture.'))
    })
    recorder.start()
    let frame = 0
    let nextFrameAt = 0
    const paint = (now: number) => {
      if (now < nextFrameAt) {
        requestAnimationFrame(paint)
        return
      }
      context.fillStyle = frame % 2 ? '#88a84e' : '#337b82'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.fillStyle = '#f1f1e8'
      context.fillRect((frame * 5) % 280, 68, 40, 40)
      frame += 1
      nextFrameAt = now + 1000 / 24
      if (frame < frameCount) requestAnimationFrame(paint)
      else recorder.stop()
    }
    requestAnimationFrame(paint)
    await finished
    oscillator.stop()
    await audioContext.close()
    const blob = new Blob(chunks, { type: 'video/webm' })
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  }, frameCount)
}

function makeToneWav(durationSeconds = 3, sampleRate = 48_000) {
  const sampleCount = durationSeconds * sampleRate
  const bytes = Buffer.alloc(44 + sampleCount * 2)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(sampleRate, 24)
  bytes.writeUInt32LE(sampleRate * 2, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(sampleCount * 2, 40)
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.round(Math.sin((index * 2 * Math.PI * 440) / sampleRate) * 8_000)
    bytes.writeInt16LE(value, 44 + index * 2)
  }
  return bytes
}

test('imports, previews, edits, saves, and reopens a local video', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(page.getByText('VANTACUT STUDIO')).toBeVisible()

  const videoBytes = await makeVideo(page)
  await page.locator('input[type="file"][accept*="video"]').setInputFiles({
    name: 'local-take.webm',
    mimeType: 'video/webm',
    buffer: Buffer.from(videoBytes),
  })
  await expect(page.getByText('local-take.webm', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Add local-take.webm to timeline' }).click()
  await expect(page.locator('.timeline-clip')).toHaveCount(2)

  await page.getByRole('button', { name: 'Play', exact: true }).click()
  const video = page.locator('.preview-video')
  await expect(video).toBeVisible()
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime), { timeout: 5_000 }).toBeGreaterThan(0.05)
  const linkedAudio = page.locator('.audio-source')
  await expect.poll(() => linkedAudio.evaluate((element) => (element as HTMLAudioElement).currentTime), { timeout: 5_000 }).toBeGreaterThan(0.05)
  await page.getByRole('button', { name: 'Pause', exact: true }).click()

  const ruler = page.locator('.timeline-ruler')
  await ruler.click({ position: { x: 24, y: 12 } })
  await page.getByRole('button', { name: 'Split', exact: true }).click()
  await expect(page.locator('.timeline-clip')).toHaveCount(4)
  await page.locator('.timeline-clip').nth(2).click()
  await page.locator('button[title="Trim out by one frame"]').click()
  await expect(page.getByText('Nothing selected')).toHaveCount(0)

  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Save project' }).click()
  const download = await downloadEvent
  expect(download.suggestedFilename()).toMatch(/\.vcut$/)
  const downloadedPath = await download.path()
  if (!downloadedPath) throw new Error('The project download was not saved.')
  const savedProject = JSON.parse(await readFile(downloadedPath, 'utf8')) as { clips: unknown[]; assets: unknown[] }
  expect(savedProject.clips).toHaveLength(4)
  expect(savedProject.assets).toHaveLength(1)

  await page.locator('input[type="file"][accept*=".vcut"]').setInputFiles({
    name: 'roundtrip.vcut',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(savedProject)),
  })
  await expect(page.locator('.timeline-clip')).toHaveCount(4)
  await expect(page.getByText('Project opened.')).toBeVisible()
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(page.getByLabel('CONTAINER')).toHaveValue('WebM')
  await expect(page.getByRole('button', { name: 'Start Export' })).toBeEnabled()
  await page.getByRole('button', { name: 'Close export dialog' }).click()
  await page.screenshot({ path: 'test-results/editor-desktop.png', fullPage: true })
})

test('plays, seeks, mutes, and changes gain on an audio-only timeline', async ({ page }) => {
  await page.goto('/')
  await page.locator('input[type="file"][accept*="audio"]').setInputFiles({
    name: 'tone-440.wav',
    mimeType: 'audio/wav',
    buffer: makeToneWav(),
  })
  await expect(page.getByText('tone-440.wav', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Add tone-440.wav to timeline' }).click()
  const player = page.locator('.audio-source')
  await expect(player).toHaveCount(1)

  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect.poll(() => player.evaluate((element) => (element as HTMLAudioElement).currentTime), { timeout: 5_000 }).toBeGreaterThan(0.1)
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect.poll(() => player.evaluate((element) => (element as HTMLAudioElement).paused)).toBe(true)

  await page.locator('.timeline-ruler').click({ position: { x: 48, y: 12 } })
  await expect.poll(() => player.evaluate((element) => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(0.5)
  await page.locator('.timeline-clip').click()
  const gain = page.getByRole('slider', { name: 'Clip gain' })
  await gain.focus()
  await gain.press('Home')
  for (let index = 0; index < 35; index += 1) await gain.press('ArrowRight')
  await expect.poll(() => player.evaluate((element) => (element as HTMLAudioElement).volume)).toBeCloseTo(0.35)
  await page.getByRole('button', { name: 'Mute track' }).click()
  await expect.poll(() => player.evaluate((element) => (element as HTMLAudioElement).muted)).toBe(true)
  await page.getByRole('button', { name: 'Unmute track' }).click()
  await expect.poll(() => player.evaluate((element) => (element as HTMLAudioElement).muted)).toBe(false)
})

test('opens native editor context menus and applies their timeline actions', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.locator('input[type="file"][accept*="audio"]').setInputFiles({
    name: 'context-tone.wav',
    mimeType: 'audio/wav',
    buffer: makeToneWav(),
  })
  await page.getByRole('button', { name: 'Add context-tone.wav to timeline' }).click()
  const clip = page.locator('.timeline-clip')
  await clip.click({ button: 'right' })
  const clipMenu = page.getByRole('menu')
  await expect(clipMenu).toContainText('Duplicate')
  await clipMenu.getByRole('menuitem', { name: 'Duplicate' }).click()
  await expect(clip).toHaveCount(2)

  await clip.first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await expect(clip).toHaveCount(1)

  await page.locator('.track-gutter').filter({ hasText: 'A1' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Add Audio Track Above' }).click()
  await expect(page.locator('.track-row')).toHaveCount(4)

  await page.locator('[data-context-ruler="sequence"]').first().click({ button: 'right' })
  const menu = page.getByRole('menu')
  await expect(menu).toContainText('Go to Sequence Start')
  const menuBounds = await menu.boundingBox()
  if (!menuBounds) throw new Error('Ruler context menu is not visible.')
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(1440)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)

  await clip.click({ button: 'right' })
  await page.getByRole('button', { name: 'Export' }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('renders and validates a real WebM sequence export', async ({ page }) => {
  await page.goto('/')
  const bytes = await makeVideo(page, 72)
  await page.locator('input[type="file"][accept*="video"]').setInputFiles({ name: 'export-source.webm', mimeType: 'video/webm', buffer: Buffer.from(bytes) })
  await page.getByRole('button', { name: 'Add export-source.webm to timeline' }).click()
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(page.getByLabel('CODECS')).toHaveValue('VP8 + Opus')
  await page.getByRole('textbox', { name: 'Output filename' }).fill('edited-sequence.webm')
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Start Export' }).click()
  const download = await downloadEvent
  const downloadedPath = await download.path()
  if (!downloadedPath) throw new Error('The completed WebM download is missing.')
  await expect(page.locator('.export-success')).toContainText('Export finished and passed browser media validation.')

  const probe = await page.context().newPage()
  await probe.goto(`file://${downloadedPath}`)
  const metadata = await probe.locator('video').evaluate((element) => {
    const video = element as HTMLVideoElement
    return { duration: video.duration, width: video.videoWidth, height: video.videoHeight }
  })
  expect(metadata.duration === Infinity || (metadata.duration > 2.5 && metadata.duration < 4)).toBe(true)
  expect(metadata.width).toBeGreaterThan(0)
  expect(metadata.height).toBeGreaterThan(0)

  const ffmpegDirectory = process.env.PLAYWRIGHT_FFMPEG_DIR ?? join(homedir(), '.cache', 'ms-playwright')
  const ffmpegBuild = readdirSync(ffmpegDirectory).filter((name) => name.startsWith('ffmpeg-')).sort().at(-1)
  if (!ffmpegBuild) throw new Error('The export test requires a local FFmpeg media probe.')
  const ffmpegName = process.platform === 'win32' ? 'ffmpeg-win64.exe' : 'ffmpeg-linux'
  const ffmpegPath = process.env.FFMPEG_PATH ?? join(ffmpegDirectory, ffmpegBuild, ffmpegName)
  const probeResult = spawnSync(ffmpegPath, ['-hide_banner', '-i', downloadedPath], { encoding: 'utf8' })
  const probeText = `${probeResult.stdout ?? ''}\n${probeResult.stderr ?? ''}`
  expect(probeText).toMatch(/Input #0, matroska,webm/)
  expect(probeText).toMatch(/Video: vp8/i)
  expect(probeText).toMatch(/Audio: opus/i)
  expect(probeText).toMatch(/Duration: 00:00:0[23]\./)
  await probe.close()
})

test('keeps the workspace usable at a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.locator('.empty-bin').getByRole('button', { name: 'Import media' })).toBeVisible()
  await expect(page.getByText('TIMELINE', { exact: true })).toBeVisible()
  await expect(page.locator('.monitor-panel')).toBeInViewport()
  await page.screenshot({ path: 'test-results/editor-mobile.png', fullPage: true })
})
