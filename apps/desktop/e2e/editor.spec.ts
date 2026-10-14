import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

async function makeVideo(page: Page) {
  return page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 180
    const context = canvas.getContext('2d')
    if (!context || !MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) {
      throw new Error('This browser cannot encode the local WebM test fixture.')
    }
    const recorder = new MediaRecorder(canvas.captureStream(24), { mimeType: 'video/webm;codecs=vp8' })
    const chunks: BlobPart[] = []
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
    const finished = new Promise<void>((resolve, reject) => {
      recorder.onstop = () => resolve()
      recorder.onerror = () => reject(new Error('Could not record the local WebM test fixture.'))
    })
    recorder.start()
    let frame = 0
    const paint = () => {
      context.fillStyle = frame % 2 ? '#88a84e' : '#337b82'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.fillStyle = '#f1f1e8'
      context.fillRect((frame * 5) % 280, 68, 40, 40)
      frame += 1
      if (frame < 42) requestAnimationFrame(paint)
      else recorder.stop()
    }
    requestAnimationFrame(paint)
    await finished
    const blob = new Blob(chunks, { type: 'video/webm' })
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  })
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
  await expect(page.locator('.timeline-clip')).toHaveCount(1)

  await page.getByRole('button', { name: 'Play', exact: true }).click()
  const video = page.locator('.preview-video')
  await expect(video).toBeVisible()
  await expect.poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime), { timeout: 5_000 }).toBeGreaterThan(0.05)
  await page.getByRole('button', { name: 'Pause', exact: true }).click()

  const ruler = page.locator('.timeline-ruler')
  await ruler.click({ position: { x: 24, y: 12 } })
  await page.getByRole('button', { name: 'Split', exact: true }).click()
  await expect(page.locator('.timeline-clip')).toHaveCount(2)
  await page.locator('.timeline-clip').nth(1).click()
  await page.locator('button[title="Trim out by one frame"]').click()
  await expect(page.getByText('Nothing selected')).toHaveCount(0)

  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Save project' }).click()
  const download = await downloadEvent
  expect(download.suggestedFilename()).toMatch(/\.vcut$/)
  const downloadedPath = await download.path()
  if (!downloadedPath) throw new Error('The project download was not saved.')
  const savedProject = JSON.parse(await readFile(downloadedPath, 'utf8')) as { clips: unknown[]; assets: unknown[] }
  expect(savedProject.clips).toHaveLength(2)
  expect(savedProject.assets).toHaveLength(1)

  await page.locator('input[type="file"][accept*=".vcut"]').setInputFiles({
    name: 'roundtrip.vcut',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(savedProject)),
  })
  await expect(page.locator('.timeline-clip')).toHaveCount(2)
  await expect(page.getByText('Project opened.')).toBeVisible()
  await page.getByRole('button', { name: 'Export' }).click()
  await expect(page.getByRole('dialog')).toContainText('no validated encoder detected')
  await expect(page.getByRole('button', { name: 'Save project instead' })).toBeVisible()
  await page.getByRole('button', { name: 'Close export dialog' }).click()
  await page.screenshot({ path: 'test-results/editor-desktop.png', fullPage: true })
})

test('keeps the workspace usable at a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.locator('.empty-bin').getByRole('button', { name: 'Import media' })).toBeVisible()
  await expect(page.getByText('TIMELINE', { exact: true })).toBeVisible()
  await expect(page.locator('.monitor-panel')).toBeInViewport()
  await page.screenshot({ path: 'test-results/editor-mobile.png', fullPage: true })
})
