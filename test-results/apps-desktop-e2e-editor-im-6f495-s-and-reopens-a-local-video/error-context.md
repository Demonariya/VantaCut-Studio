# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: apps/desktop/e2e/editor.spec.ts >> imports, previews, edits, saves, and reopens a local video
- Location: apps/desktop/e2e/editor.spec.ts:72:1

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/", waiting until "load"

```

# Test source

```ts
  1   | import { expect, test, type Page } from '@playwright/test'
  2   | import { readFile } from 'node:fs/promises'
  3   | 
  4   | async function makeVideo(page: Page) {
  5   |   return page.evaluate(async () => {
  6   |     const canvas = document.createElement('canvas')
  7   |     canvas.width = 320
  8   |     canvas.height = 180
  9   |     const context = canvas.getContext('2d')
  10  |     if (!context || !MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')) {
  11  |       throw new Error('This browser cannot encode a WebM video with an Opus audio stream.')
  12  |     }
  13  |     const audioContext = new AudioContext()
  14  |     const oscillator = audioContext.createOscillator()
  15  |     const gain = audioContext.createGain()
  16  |     const audioDestination = audioContext.createMediaStreamDestination()
  17  |     gain.gain.value = 0.15
  18  |     oscillator.frequency.value = 440
  19  |     oscillator.connect(gain).connect(audioDestination)
  20  |     oscillator.start()
  21  |     const stream = canvas.captureStream(24)
  22  |     audioDestination.stream.getAudioTracks().forEach((track) => stream.addTrack(track))
  23  |     const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' })
  24  |     const chunks: BlobPart[] = []
  25  |     recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
  26  |     const finished = new Promise<void>((resolve, reject) => {
  27  |       recorder.onstop = () => resolve()
  28  |       recorder.onerror = () => reject(new Error('Could not record the local WebM test fixture.'))
  29  |     })
  30  |     recorder.start()
  31  |     let frame = 0
  32  |     const paint = () => {
  33  |       context.fillStyle = frame % 2 ? '#88a84e' : '#337b82'
  34  |       context.fillRect(0, 0, canvas.width, canvas.height)
  35  |       context.fillStyle = '#f1f1e8'
  36  |       context.fillRect((frame * 5) % 280, 68, 40, 40)
  37  |       frame += 1
  38  |       if (frame < 42) requestAnimationFrame(paint)
  39  |       else recorder.stop()
  40  |     }
  41  |     requestAnimationFrame(paint)
  42  |     await finished
  43  |     oscillator.stop()
  44  |     await audioContext.close()
  45  |     const blob = new Blob(chunks, { type: 'video/webm' })
  46  |     return Array.from(new Uint8Array(await blob.arrayBuffer()))
  47  |   })
  48  | }
  49  | 
  50  | function makeToneWav(durationSeconds = 3, sampleRate = 48_000) {
  51  |   const sampleCount = durationSeconds * sampleRate
  52  |   const bytes = Buffer.alloc(44 + sampleCount * 2)
  53  |   bytes.write('RIFF', 0)
  54  |   bytes.writeUInt32LE(bytes.length - 8, 4)
  55  |   bytes.write('WAVEfmt ', 8)
  56  |   bytes.writeUInt32LE(16, 16)
  57  |   bytes.writeUInt16LE(1, 20)
  58  |   bytes.writeUInt16LE(1, 22)
  59  |   bytes.writeUInt32LE(sampleRate, 24)
  60  |   bytes.writeUInt32LE(sampleRate * 2, 28)
  61  |   bytes.writeUInt16LE(2, 32)
  62  |   bytes.writeUInt16LE(16, 34)
  63  |   bytes.write('data', 36)
  64  |   bytes.writeUInt32LE(sampleCount * 2, 40)
  65  |   for (let index = 0; index < sampleCount; index += 1) {
  66  |     const value = Math.round(Math.sin((index * 2 * Math.PI * 440) / sampleRate) * 8_000)
  67  |     bytes.writeInt16LE(value, 44 + index * 2)
  68  |   }
  69  |   return bytes
  70  | }
  71  | 
  72  | test('imports, previews, edits, saves, and reopens a local video', async ({ page }) => {
  73  |   await page.setViewportSize({ width: 1440, height: 900 })
> 74  |   await page.goto('/')
      |              ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  75  |   await expect(page.getByText('VANTACUT STUDIO')).toBeVisible()
  76  | 
  77  |   const videoBytes = await makeVideo(page)
  78  |   await page.locator('input[type="file"][accept*="video"]').setInputFiles({
  79  |     name: 'local-take.webm',
  80  |     mimeType: 'video/webm',
  81  |     buffer: Buffer.from(videoBytes),
  82  |   })
  83  |   await expect(page.getByText('local-take.webm', { exact: true })).toBeVisible()
  84  |   await page.getByRole('button', { name: 'Add local-take.webm to timeline' }).click()
  85  |   await expect(page.locator('.timeline-clip')).toHaveCount(2)
  86  | 
  87  |   await page.getByRole('button', { name: 'Play', exact: true }).click()
  88  |   const video = page.locator('.preview-video')
  89  |   await expect(video).toBeVisible()
  90  |   await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime), { timeout: 5_000 }).toBeGreaterThan(0.05)
  91  |   const linkedAudio = page.locator('.audio-source')
  92  |   await expect.poll(() => linkedAudio.evaluate((element) => (element as HTMLAudioElement).currentTime), { timeout: 5_000 }).toBeGreaterThan(0.05)
  93  |   await page.getByRole('button', { name: 'Pause', exact: true }).click()
  94  | 
  95  |   const ruler = page.locator('.timeline-ruler')
  96  |   await ruler.click({ position: { x: 24, y: 12 } })
  97  |   await page.getByRole('button', { name: 'Split', exact: true }).click()
  98  |   await expect(page.locator('.timeline-clip')).toHaveCount(4)
  99  |   await page.locator('.timeline-clip').nth(2).click()
  100 |   await page.locator('button[title="Trim out by one frame"]').click()
  101 |   await expect(page.getByText('Nothing selected')).toHaveCount(0)
  102 | 
  103 |   const downloadEvent = page.waitForEvent('download')
  104 |   await page.getByRole('button', { name: 'Save project' }).click()
  105 |   const download = await downloadEvent
  106 |   expect(download.suggestedFilename()).toMatch(/\.vcut$/)
  107 |   const downloadedPath = await download.path()
  108 |   if (!downloadedPath) throw new Error('The project download was not saved.')
  109 |   const savedProject = JSON.parse(await readFile(downloadedPath, 'utf8')) as { clips: unknown[]; assets: unknown[] }
  110 |   expect(savedProject.clips).toHaveLength(4)
  111 |   expect(savedProject.assets).toHaveLength(1)
  112 | 
  113 |   await page.locator('input[type="file"][accept*=".vcut"]').setInputFiles({
  114 |     name: 'roundtrip.vcut',
  115 |     mimeType: 'application/json',
  116 |     buffer: Buffer.from(JSON.stringify(savedProject)),
  117 |   })
  118 |   await expect(page.locator('.timeline-clip')).toHaveCount(4)
  119 |   await expect(page.getByText('Project opened.')).toBeVisible()
  120 |   await page.getByRole('button', { name: 'Export' }).click()
  121 |   await expect(page.getByRole('dialog')).toContainText('no validated encoder detected')
  122 |   await expect(page.getByRole('button', { name: 'Save project instead' })).toBeVisible()
  123 |   await page.getByRole('button', { name: 'Close export dialog' }).click()
  124 |   await page.screenshot({ path: 'test-results/editor-desktop.png', fullPage: true })
  125 | })
  126 | 
  127 | test('plays, seeks, mutes, and changes gain on an audio-only timeline', async ({ page }) => {
  128 |   await page.goto('/')
  129 |   await page.locator('input[type="file"][accept*="audio"]').setInputFiles({
  130 |     name: 'tone-440.wav',
  131 |     mimeType: 'audio/wav',
  132 |     buffer: makeToneWav(),
  133 |   })
  134 |   await expect(page.getByText('tone-440.wav', { exact: true })).toBeVisible()
  135 |   await page.getByRole('button', { name: 'Add tone-440.wav to timeline' }).click()
  136 |   const player = page.locator('.audio-source')
  137 |   await expect(player).toHaveCount(1)
  138 | 
  139 |   await page.getByRole('button', { name: 'Play', exact: true }).click()
  140 |   await expect.poll(() => player.evaluate((element) => (element as HTMLAudioElement).currentTime), { timeout: 5_000 }).toBeGreaterThan(0.1)
  141 |   await page.getByRole('button', { name: 'Pause', exact: true }).click()
  142 |   await expect.poll(() => player.evaluate((element) => (element as HTMLAudioElement).paused)).toBe(true)
  143 | 
  144 |   await page.locator('.timeline-ruler').click({ position: { x: 48, y: 12 } })
  145 |   await expect.poll(() => player.evaluate((element) => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(0.5)
  146 |   await page.locator('.timeline-clip').click()
  147 |   const gain = page.getByRole('slider', { name: 'Clip gain' })
  148 |   await gain.focus()
  149 |   await gain.press('Home')
  150 |   for (let index = 0; index < 35; index += 1) await gain.press('ArrowRight')
  151 |   await expect.poll(() => player.evaluate((element) => (element as HTMLAudioElement).volume)).toBeCloseTo(0.35)
  152 |   await page.getByRole('button', { name: 'Mute track' }).click()
  153 |   await expect.poll(() => player.evaluate((element) => (element as HTMLAudioElement).muted)).toBe(true)
  154 |   await page.getByRole('button', { name: 'Unmute track' }).click()
  155 |   await expect.poll(() => player.evaluate((element) => (element as HTMLAudioElement).muted)).toBe(false)
  156 | })
  157 | 
  158 | test('keeps the workspace usable at a mobile viewport', async ({ page }) => {
  159 |   await page.setViewportSize({ width: 390, height: 844 })
  160 |   await page.goto('/')
  161 |   await expect(page.locator('.empty-bin').getByRole('button', { name: 'Import media' })).toBeVisible()
  162 |   await expect(page.getByText('TIMELINE', { exact: true })).toBeVisible()
  163 |   await expect(page.locator('.monitor-panel')).toBeInViewport()
  164 |   await page.screenshot({ path: 'test-results/editor-mobile.png', fullPage: true })
  165 | })
  166 | 
```