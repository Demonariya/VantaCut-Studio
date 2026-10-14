import fixWebmDuration from 'fix-webm-duration'
import {
  framesToSeconds,
  sequenceDurationFrames,
  type Clip,
  type Project,
  type TrackKind,
} from '../domain/timeline'

export type ExportStage = 'preparing' | 'rendering' | 'finalizing' | 'completed' | 'cancelled' | 'failed'
export type ExportProgress = (stage: ExportStage, progress: number) => void

interface Options {
  audioOnly?: boolean
  bitrate?: number
}

interface RenderSource {
  clip: Clip
  kind: TrackKind
  media: HTMLVideoElement | HTMLAudioElement | HTMLImageElement
}

function abortError() {
  return new DOMException('Export cancelled.', 'AbortError')
}

function waitForMetadata(media: HTMLMediaElement, signal: AbortSignal): Promise<void> {
  if (media.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      media.removeEventListener('loadedmetadata', onReady)
      media.removeEventListener('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const onReady = () => { cleanup(); resolve() }
    const onError = () => { cleanup(); reject(new Error('A source could not be decoded for export.')) }
    const onAbort = () => { cleanup(); reject(abortError()) }
    media.addEventListener('loadedmetadata', onReady, { once: true })
    media.addEventListener('error', onError, { once: true })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

function activeClip(sources: RenderSource[], frame: number) {
  return sources.filter(({ clip }) => clip.enabled !== false && frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames)
}

function setSourceTime(media: HTMLMediaElement, clip: Clip, frame: number, project: Project) {
  const seconds = framesToSeconds(clip.sourceInFrame + frame - clip.startFrame, project.frameRate)
  if (Math.abs(media.currentTime - seconds) > 0.18) media.currentTime = seconds
}

export async function renderWebm(
  project: Project,
  mediaUrls: Record<string, string>,
  options: Options,
  onProgress: ExportProgress,
  signal: AbortSignal,
): Promise<Blob> {
  const durationFrames = sequenceDurationFrames(project)
  if (durationFrames <= 0) throw new Error('Add a clip to the timeline before exporting.')
  const frameRate = project.frameRate.numerator / project.frameRate.denominator
  if (!Number.isFinite(frameRate) || frameRate < 1 || frameRate > 120) throw new Error('The sequence frame rate is not supported for browser rendering.')
  const mimeType = options.audioOnly
    ? 'audio/webm;codecs=opus'
    : 'video/webm;codecs=vp8,opus'
  if (!MediaRecorder.isTypeSupported(mimeType)) throw new Error(`This browser does not support ${mimeType}.`)

  onProgress('preparing', 0)
  const sources: RenderSource[] = []
  const trackKinds = new Map(project.tracks.map((track) => [track.id, track.kind]))
  const visibleTracks = project.tracks.filter((track) => !track.hidden)
  for (const clip of project.clips) {
    if (clip.enabled === false) continue
    const asset = project.assets.find((item) => item.id === clip.assetId)
    const url = mediaUrls[clip.assetId]
    const kind = trackKinds.get(clip.trackId)
    if (!asset || !url || !kind) throw new Error(`Missing source media for clip ${clip.id}. Relink the source before exporting.`)
    if (kind === 'video' && asset.kind === 'audio') throw new Error(`Audio-only source ${asset.name} is placed on a video track.`)
    if (kind === 'audio' && asset.kind === 'image') throw new Error(`Still image ${asset.name} cannot be rendered as audio.`)
    const media = asset.kind === 'image' ? new Image() : document.createElement(kind === 'audio' ? 'audio' : 'video')
    if (media instanceof HTMLMediaElement) {
      media.preload = 'auto'
      media.src = url
      media.load()
    } else {
      media.src = url
    }
    sources.push({ clip, kind, media })
  }

  const controller = new AbortController()
  const cleanup = () => {
    controller.abort()
    sources.forEach(({ media }) => {
      if (media instanceof HTMLMediaElement) {
        media.pause()
        media.removeAttribute('src')
        media.load()
      }
    })
  }
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) controller.abort()

  let audioContext: AudioContext | undefined
  let animationFrame = 0
  let recorder: MediaRecorder | undefined
  let stream: MediaStream | undefined
  try {
    const metadata = sources.filter(({ media }) => media instanceof HTMLMediaElement)
    await Promise.all(metadata.map(({ media }) => waitForMetadata(media as HTMLMediaElement, controller.signal)))
    if (controller.signal.aborted) throw abortError()

    const audioSources = sources.filter(({ kind }) => kind === 'audio')
    let mixedAudio: MediaStreamAudioDestinationNode | undefined
    if (audioSources.length) {
      audioContext = new AudioContext({ sampleRate: project.audioSampleRate })
      mixedAudio = audioContext.createMediaStreamDestination()
      const compressor = audioContext.createDynamicsCompressor()
      compressor.threshold.value = -3
      compressor.knee.value = 8
      compressor.ratio.value = 8
      compressor.attack.value = 0.005
      compressor.release.value = 0.18
      compressor.connect(mixedAudio)
      for (const source of audioSources) {
        const media = source.media as HTMLAudioElement
        const elementSource = audioContext.createMediaElementSource(media)
        const gain = audioContext.createGain()
        const track = project.tracks.find((item) => item.id === source.clip.trackId)
        const soloed = project.tracks.some((item) => item.kind === 'audio' && item.solo)
        const muted = Boolean(source.clip.muted || track?.muted || (soloed && !track?.solo))
        gain.gain.value = muted ? 0 : Math.max(0, Math.min(1, source.clip.volume))
        elementSource.connect(gain)
        gain.connect(compressor)
        gain.connect(audioContext.destination)
      }
      await audioContext.resume()
    }

    const canvas = options.audioOnly ? undefined : document.createElement('canvas')
    const context = canvas?.getContext('2d', { alpha: false })
    if (canvas) {
      canvas.width = project.width
      canvas.height = project.height
      if (!context) throw new Error('The browser could not create an export canvas.')
    }
    const videoStream = canvas?.captureStream(frameRate)
    const tracks = [...(videoStream?.getVideoTracks() ?? []), ...(mixedAudio?.stream.getAudioTracks() ?? [])]
    if (!tracks.length) throw new Error('The project contains no enabled media streams to export.')
    stream = new MediaStream(tracks)
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: options.bitrate ?? 8_000_000, audioBitsPerSecond: 192_000 })
    const chunks: BlobPart[] = []
    const recording = new Promise<Blob>((resolve, reject) => {
      recorder!.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
      recorder!.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType })
        if (blob.size === 0) reject(new Error('The browser renderer produced an empty file.'))
        else resolve(blob)
      }
      recorder!.onerror = () => reject(new Error('The browser media recorder failed during rendering.'))
    })

    await new Promise<void>((resolve, reject) => {
      recorder!.start(250)
      onProgress('rendering', 0)
      const renderFrame = (now: number) => {
        if (controller.signal.aborted) {
          recorder?.state === 'recording' && recorder.stop()
          reject(abortError())
          return
        }
        const frame = Math.min(durationFrames, Math.floor(((now - startedAt) / 1000) * frameRate))
        if (canvas && context) {
          context.fillStyle = '#000'
          context.fillRect(0, 0, canvas.width, canvas.height)
          const activeByTrack = new Map<string, RenderSource>()
          for (const item of activeClip(sources, frame)) {
            if (item.kind === 'video') activeByTrack.set(item.clip.trackId, item)
          }
          for (const track of visibleTracks.filter((item) => item.kind === 'video')) {
            const source = activeByTrack.get(track.id)
            if (!source) continue
            if (!(source.media instanceof HTMLVideoElement) && !(source.media instanceof HTMLImageElement)) continue
            const media = source.media
            const width = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth
            const height = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight
            if (media instanceof HTMLVideoElement) {
              setSourceTime(media, source.clip, frame, project)
              if (media.paused) void media.play().catch(() => {})
              if (media.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) continue
            }
            if (!width || !height) continue
            context.save()
            context.globalAlpha = Math.max(0, Math.min(1, source.clip.opacity))
            context.filter = `brightness(${100 + source.clip.brightness}%) contrast(${100 + source.clip.contrast}%) saturate(${100 + source.clip.saturation}%)`
            const scale = Math.min(canvas.width / width, canvas.height / height)
            const drawWidth = width * scale
            const drawHeight = height * scale
            context.drawImage(media, (canvas.width - drawWidth) / 2, (canvas.height - drawHeight) / 2, drawWidth, drawHeight)
            context.restore()
          }
        }

        const audioClips = activeClip(audioSources, frame)
        for (const source of audioSources) {
          const media = source.media as HTMLAudioElement
          if (audioClips.includes(source)) {
            setSourceTime(media, source.clip, frame, project)
            if (media.paused) void media.play().catch(() => {})
          } else {
            media.pause()
          }
        }
        onProgress('rendering', frame / durationFrames)
        if (frame >= durationFrames) {
          resolve()
          return
        }
        animationFrame = requestAnimationFrame(renderFrame)
      }
      const startedAt = performance.now()
      animationFrame = requestAnimationFrame(renderFrame)
    })
    onProgress('finalizing', 1)
    recorder.stop()
    const output = await recording
    const finalized = await fixWebmDuration(output, framesToSeconds(durationFrames, project.frameRate) * 1000, { logger: false })
    onProgress('completed', 1)
    return finalized
  } catch (error) {
    if (controller.signal.aborted) onProgress('cancelled', 0)
    else onProgress('failed', 0)
    if (recorder?.state === 'recording') recorder.stop()
    throw error
  } finally {
    cancelAnimationFrame(animationFrame)
    stream?.getTracks().forEach((track) => track.stop())
    await audioContext?.close().catch(() => {})
    cleanup()
    signal.removeEventListener('abort', abort)
  }
}
