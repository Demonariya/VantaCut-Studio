import {
  AudioLines,
  Check,
  ChevronDown,
  Clapperboard,
  Clock3,
  Download,
  Eye,
  EyeOff,
  FileVideo2,
  FolderOpen,
  Image,
  LockKeyhole,
  Minus,
  Pause,
  Play,
  Plus,
  Redo2,
  Scissors,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  UnlockKeyhole,
  Undo2,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type MouseEvent } from 'react'
import {
  commit,
  createProject,
  formatTimecode,
  framesToSeconds,
  isProject,
  redo,
  secondsToFrames,
  sequenceDurationFrames,
  undo,
  type Clip,
  type History,
  type MediaAsset,
  type Project,
  type TimelineCommand,
  type Track,
} from './domain/timeline'
import { loadMedia, storeMedia } from './storage/mediaStore'
import { EditorContextMenu, type ContextMenuItem } from './components/EditorContextMenu'
import { renderWebm, type ExportStage } from './media/renderWebm'
import './App.css'

const recoveryKey = 'vantacut-recovery-v1'
const framesPerSecond = (project: Project) => project.frameRate.numerator / project.frameRate.denominator
const defaultHistory = (): History => ({ past: [], present: createProject(), future: [] })
const pxPerFrameDefault = 3

type ContextTarget =
  | { kind: 'asset'; id: string; x: number; y: number }
  | { kind: 'clip'; id: string; x: number; y: number }
  | { kind: 'track'; id: string; x: number; y: number }
  | { kind: 'lane'; id: string; x: number; y: number }
  | { kind: 'ruler'; id: 'sequence'; x: number; y: number }

function initialHistory(): History {
  try {
    const saved = localStorage.getItem(recoveryKey)
    const parsed: unknown = saved ? JSON.parse(saved) : null
    if (isProject(parsed)) return { past: [], present: parsed, future: [] }
  } catch {
    return defaultHistory()
  }
  return defaultHistory()
}

function iconForAsset(kind: MediaAsset['kind']) {
  if (kind === 'audio') return <AudioLines size={15} />
  if (kind === 'image') return <Image size={15} />
  return <FileVideo2 size={15} />
}

function formatDuration(frameCount: number, project: Project) {
  const seconds = framesToSeconds(frameCount, project.frameRate)
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.floor(seconds % 60)
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

function createClip(asset: MediaAsset, trackId: string, startFrame: number): Clip {
  return {
    id: crypto.randomUUID(),
    assetId: asset.id,
    trackId,
    startFrame,
    sourceInFrame: 0,
    durationFrames: Math.max(1, asset.durationFrames),
    brightness: 0,
    contrast: 0,
    saturation: 0,
    opacity: 1,
    volume: 1,
  }
}

async function readMedia(file: File, project: Project): Promise<MediaAsset> {
  const kind: MediaAsset['kind'] = file.type.startsWith('audio/')
    ? 'audio'
    : file.type.startsWith('image/') ? 'image' : 'video'
  let durationFrames = secondsToFrames(5, project.frameRate)
  let width = 0
  let height = 0
  let thumbnail: string | null = null

  if (kind === 'image') {
    const bitmap = await createImageBitmap(file)
    width = bitmap.width
    height = bitmap.height
    const canvas = document.createElement('canvas')
    canvas.width = Math.min(width, 480)
    canvas.height = Math.round((canvas.width * height) / width)
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    thumbnail = canvas.toDataURL('image/jpeg', 0.76)
    bitmap.close()
  } else {
    const media = document.createElement(kind === 'audio' ? 'audio' : 'video')
    media.preload = 'metadata'
    const objectUrl = URL.createObjectURL(file)
    try {
      await new Promise<void>((resolve, reject) => {
        media.onloadedmetadata = () => resolve()
        media.onerror = () => reject(new Error('The browser could not read this media file.'))
        media.src = objectUrl
      })
      if (Number.isFinite(media.duration) && media.duration > 0) {
        durationFrames = secondsToFrames(media.duration, project.frameRate)
      }
      if (kind === 'video') {
        width = (media as HTMLVideoElement).videoWidth
        height = (media as HTMLVideoElement).videoHeight
      }
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  }

  return {
    id: crypto.randomUUID(),
    name: file.name,
    kind,
    mimeType: file.type || 'application/octet-stream',
    fileSize: file.size,
    modifiedAt: file.lastModified,
    durationFrames,
    width,
    height,
    sourceFrameRate: null,
    thumbnail,
  }
}

function App() {
  const [history, setHistory] = useState<History>(initialHistory)
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({})
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [playhead, setPlayhead] = useState(0)
  const [seekRevision, setSeekRevision] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [notice, setNotice] = useState('')
  const [showExportInfo, setShowExportInfo] = useState(false)
  const [exportName, setExportName] = useState('Untitled sequence.webm')
  const [exportPreset, setExportPreset] = useState<'source' | '720p' | '1080p' | 'vertical'>('source')
  const [exportAudioOnly, setExportAudioOnly] = useState(false)
  const [exportBitrate, setExportBitrate] = useState(8_000_000)
  const [exportStage, setExportStage] = useState<ExportStage | null>(null)
  const [exportProgress, setExportProgress] = useState(0)
  const [exportError, setExportError] = useState('')
  const exportAbort = useRef<AbortController | null>(null)
  const [contextTarget, setContextTarget] = useState<ContextTarget | null>(null)
  const [clipboard, setClipboard] = useState<Clip[]>([])
  const [search, setSearch] = useState('')
  const [zoom, setZoom] = useState(pxPerFrameDefault)
  const [snapping, setSnapping] = useState(true)
  const [leftTab, setLeftTab] = useState<'media' | 'effects'>('media')
  const [dragOver, setDragOver] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRefs = useRef(new Map<string, HTMLAudioElement>())
  const playbackAnchor = useRef({ frame: 0, time: 0 })
  const mediaInputRef = useRef<HTMLInputElement>(null)
  const projectInputRef = useRef<HTMLInputElement>(null)

  const project = history.present
  const startupProject = useRef(project).current
  const selectedClip = project.clips.find((clip) => clip.id === selectedClipId)
  const selectedTrack = project.tracks.find((track) => track.id === selectedClip?.trackId)
  const duration = Math.max(sequenceDurationFrames(project), secondsToFrames(12, project.frameRate))
  const sequenceEnd = sequenceDurationFrames(project)
  const activeClip = project.clips
    .filter((clip) => {
      const track = project.tracks.find((item) => item.id === clip.trackId)
      return track?.kind === 'video' && !track.hidden && playhead >= clip.startFrame && playhead < clip.startFrame + clip.durationFrames
    })
    .sort((left, right) => project.tracks.findIndex((track) => track.id === left.trackId) - project.tracks.findIndex((track) => track.id === right.trackId))
    .at(-1)
  const activeAsset = project.assets.find((asset) => asset.id === activeClip?.assetId)
  const activeClipId = activeClip?.id
  const activeClipStartFrame = activeClip?.startFrame
  const activeClipSourceInFrame = activeClip?.sourceInFrame
  const activeUrl = activeClip ? mediaUrls[activeClip.assetId] : undefined
  const selectedAsset = project.assets.find((asset) => asset.id === selectedClip?.assetId)
  const filteredAssets = project.assets.filter((asset) => asset.name.toLowerCase().includes(search.toLowerCase()))
  const canUndo = history.past.length > 0
  const canRedo = history.future.length > 0
  const contextItems: ContextMenuItem[] = contextTarget ? (() => {
    if (contextTarget.kind === 'asset') {
      const asset = project.assets.find((item) => item.id === contextTarget.id)
      const inUse = project.clips.some((clip) => clip.assetId === contextTarget.id)
      return asset ? [
        { id: 'asset-add', label: 'Add to Timeline' },
        { id: 'asset-rename', label: 'Rename Display Name' },
        { id: 'asset-properties', label: 'Show Properties', separatorBefore: true },
        { id: 'asset-remove', label: 'Remove from Project', disabled: inUse, separatorBefore: true },
      ] : []
    }
    if (contextTarget.kind === 'clip') {
      const clip = project.clips.find((item) => item.id === contextTarget.id)
      if (!clip) return []
      const paired = clip.linkGroupId ? project.clips.filter((item) => item.linkGroupId === clip.linkGroupId).length > 1 : false
      return [
        { id: 'clip-select', label: 'Select Clip' },
        { id: 'clip-cut', label: 'Cut', shortcut: 'Ctrl+X', separatorBefore: true },
        { id: 'clip-copy', label: 'Copy', shortcut: 'Ctrl+C' },
        { id: 'clip-paste', label: 'Paste', shortcut: 'Ctrl+V', disabled: !clipboard.length },
        { id: 'clip-duplicate', label: 'Duplicate', shortcut: 'Ctrl+D', separatorBefore: true },
        { id: 'clip-split', label: 'Split at Playhead', disabled: playhead <= clip.startFrame || playhead >= clip.startFrame + clip.durationFrames },
        { id: 'clip-delete', label: 'Delete', shortcut: 'Delete', separatorBefore: true },
        { id: 'clip-ripple', label: 'Ripple Delete' },
        { id: 'clip-toggle', label: clip.enabled === false ? 'Enable Clip' : 'Disable Clip', separatorBefore: true },
        ...(paired ? [{ id: 'clip-unlink', label: 'Unlink Audio and Video' }] : []),
        { id: 'clip-properties', label: 'Properties', separatorBefore: true },
      ]
    }
    if (contextTarget.kind === 'track') {
      const track = project.tracks.find((item) => item.id === contextTarget.id)
      if (!track) return []
      return [
        { id: 'track-add-above', label: `Add ${track.kind === 'video' ? 'Video' : 'Audio'} Track Above` },
        { id: 'track-add-below', label: `Add ${track.kind === 'video' ? 'Video' : 'Audio'} Track Below` },
        { id: 'track-rename', label: 'Rename Track', separatorBefore: true },
        { id: 'track-lock', label: track.locked ? 'Unlock Track' : 'Lock Track' },
        ...(track.kind === 'audio' ? [
          { id: 'track-mute', label: track.muted ? 'Unmute Track' : 'Mute Track' },
          { id: 'track-solo', label: track.solo ? 'Unsolo Track' : 'Solo Track' },
        ] : [{ id: 'track-toggle', label: track.hidden ? 'Enable Track' : 'Disable Track' }]),
        { id: 'track-delete', label: 'Delete Track', disabled: project.tracks.filter((item) => item.kind === track.kind).length < 2, separatorBefore: true },
      ]
    }
    if (contextTarget.kind === 'lane') return [
      { id: 'lane-add-video', label: 'Add Video Track' },
      { id: 'lane-add-audio', label: 'Add Audio Track' },
      { id: 'lane-paste', label: 'Paste', shortcut: 'Ctrl+V', disabled: !clipboard.length },
    ]
    return [
      { id: 'ruler-start', label: 'Go to Sequence Start', shortcut: 'Home' },
      { id: 'ruler-end', label: 'Go to Sequence End', shortcut: 'End' },
      { id: 'ruler-play', label: isPlaying ? 'Pause Playback' : 'Play Sequence', shortcut: 'Space' },
    ]
  })() : []

  useEffect(() => {
    let cancelled = false
    const restore = async () => {
      try {
        const loaded = await Promise.all(startupProject.assets.map(async (asset) => {
          const blob = await loadMedia(asset.id)
          return blob ? [asset.id, URL.createObjectURL(blob)] as const : null
        }))
        if (cancelled) {
          loaded.forEach((entry) => entry && URL.revokeObjectURL(entry[1]))
          return
        }
        setMediaUrls(Object.fromEntries(loaded.filter((entry): entry is readonly [string, string] => entry !== null)))
        const missing = startupProject.assets.filter((asset) => !loaded.some((entry) => entry?.[0] === asset.id))
        if (missing.length) setNotice(`${missing.length} source file${missing.length === 1 ? '' : 's'} are not in this browser's local media cache.`)
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Could not restore the last project.')
      }
    }
    void restore()
    return () => { cancelled = true }
  }, [startupProject])

  useEffect(() => {
    try {
      localStorage.setItem(recoveryKey, JSON.stringify(project))
    } catch {
      queueMicrotask(() => setNotice('Autosave could not write to browser storage. Save a .vcut project file.'))
    }
  }, [project])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !activeClipId || !activeUrl || activeAsset?.kind !== 'video'
      || activeClipStartFrame === undefined || activeClipSourceInFrame === undefined) {
      if (video) video.pause()
      return
    }
    const targetTime = framesToSeconds(activeClipSourceInFrame + playhead - activeClipStartFrame, project.frameRate)
    if (video.src !== activeUrl) video.src = activeUrl
    const sync = () => {
      const safeTime = Math.max(0, Math.min(targetTime, video.duration || targetTime))
      if (Math.abs(video.currentTime - safeTime) > 0.12) video.currentTime = safeTime
      if (isPlaying) void video.play().catch(() => setIsPlaying(false))
      else video.pause()
    }
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) sync()
    else video.onloadedmetadata = sync
    return () => { video.onloadedmetadata = null }
  }, [activeAsset?.kind, activeClipId, activeClipSourceInFrame, activeClipStartFrame, activeUrl, isPlaying, playhead, project.frameRate, seekRevision])

  useEffect(() => {
    const audioClips = project.clips.filter((clip) => project.tracks.some((track) => track.id === clip.trackId && track.kind === 'audio'))
    const soloedTracks = new Set(project.tracks.filter((track) => track.kind === 'audio' && track.solo).map((track) => track.id))
    for (const clip of audioClips) {
      const player = audioRefs.current.get(clip.id)
      if (!player) continue
      const track = project.tracks.find((item) => item.id === clip.trackId)
      const asset = project.assets.find((item) => item.id === clip.assetId)
      const muted = !track || track.muted || Boolean(clip.muted) || (soloedTracks.size > 0 && !soloedTracks.has(track.id))
      player.volume = Math.max(0, Math.min(1, clip.volume))
      player.muted = muted
      const clipEnd = clip.startFrame + clip.durationFrames
      const active = playhead >= clip.startFrame && playhead < clipEnd && Boolean(mediaUrls[clip.assetId])
      const sourceFrame = clip.sourceInFrame + Math.max(0, playhead - clip.startFrame)
      const targetSeconds = framesToSeconds(sourceFrame, project.frameRate)
      const syncAudio = () => {
        if (Math.abs(player.currentTime - targetSeconds) > 0.2) player.currentTime = targetSeconds
        if (isPlaying && !muted && player.paused) {
          void player.play().catch(() => setNotice(`Audio playback was blocked for ${asset?.name ?? 'this clip'}. Press Play again to enable audio.`))
        } else if (!isPlaying || muted) {
          player.pause()
        }
      }
      if (active && (asset?.kind === 'audio' || asset?.kind === 'video')) {
        if (player.readyState >= HTMLMediaElement.HAVE_METADATA) syncAudio()
        else player.onloadedmetadata = syncAudio
      } else {
        player.onloadedmetadata = null
        player.pause()
        if (player.readyState >= HTMLMediaElement.HAVE_METADATA && playhead <= clip.startFrame
          && Math.abs(player.currentTime - framesToSeconds(clip.sourceInFrame, project.frameRate)) > 0.2) {
          player.currentTime = framesToSeconds(clip.sourceInFrame, project.frameRate)
        }
      }
    }
  }, [isPlaying, mediaUrls, playhead, project.assets, project.clips, project.frameRate, project.tracks, seekRevision])

  useEffect(() => {
    if (!isPlaying || sequenceEnd <= 0) return
    let requestId = 0
    const advance = (now: number) => {
      const anchor = playbackAnchor.current
      const frame = anchor.frame + secondsToFrames((now - anchor.time) / 1000, project.frameRate)
      if (frame >= sequenceEnd) {
        setPlayhead(sequenceEnd)
        setIsPlaying(false)
        for (const player of audioRefs.current.values()) player.pause()
        return
      }
      setPlayhead(frame)
      requestId = requestAnimationFrame(advance)
    }
    requestId = requestAnimationFrame(advance)
    return () => cancelAnimationFrame(requestId)
  }, [isPlaying, project.frameRate, sequenceEnd])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.matches('input, textarea, select, [contenteditable="true"]')) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) handleRedo()
        else handleUndo()
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        handleRedo()
      } else if (event.code === 'Space') {
        event.preventDefault()
        togglePlayback()
      } else if (event.key.toLowerCase() === 's') {
        splitSelected()
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        deleteSelected()
      } else if (event.key === 'ArrowLeft') {
        seekTo(Math.max(0, playhead - (event.shiftKey ? Math.round(framesPerSecond(project)) : 1)))
      } else if (event.key === 'ArrowRight') {
        seekTo(Math.min(duration, playhead + (event.shiftKey ? Math.round(framesPerSecond(project)) : 1)))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  function apply(command: TimelineCommand) {
    setHistory((current) => commit(current, command))
    setIsDirty(true)
  }

  function handleUndo() {
    setHistory((current) => undo(current))
    setIsDirty(true)
  }

  function handleRedo() {
    setHistory((current) => redo(current))
    setIsDirty(true)
  }

  function seekTo(frame: number) {
    const target = Math.max(0, Math.min(duration, Math.round(frame)))
    setPlayhead(target)
    if (isPlaying) playbackAnchor.current = { frame: target, time: performance.now() }
    setSeekRevision((value) => value + 1)
  }

  function togglePlayback() {
    if (isPlaying) {
      videoRef.current?.pause()
      for (const player of audioRefs.current.values()) player.pause()
      setIsPlaying(false)
      return
    }
    const audioClip = project.clips.find((clip) => {
      const track = project.tracks.find((item) => item.id === clip.trackId)
      return track?.kind === 'audio' && playhead >= clip.startFrame && playhead < clip.startFrame + clip.durationFrames && !track.muted && !clip.muted
    })
    const clip = activeClip ?? audioClip ?? project.clips.filter((item) => item.startFrame >= playhead).sort((left, right) => left.startFrame - right.startFrame)[0]
    if (!clip) {
      setNotice('Add a video or audio clip to the timeline to start playback.')
      return
    }
    const startFrame = sequenceEnd > 0 && playhead >= sequenceEnd ? 0 : playhead
    if (startFrame !== playhead) seekTo(startFrame)
    playbackAnchor.current = { frame: startFrame, time: performance.now() }
    setIsPlaying(true)
  }

  function addAssetToTimeline(asset: MediaAsset, trackId?: string, startAt?: number) {
    const track = project.tracks.find((item) => item.id === (trackId ?? (asset.kind === 'audio' ? 'a1' : 'v1')))
    if (!track || (track.kind === 'audio' && asset.kind === 'image') || (track.kind === 'video' && asset.kind === 'audio')) {
      setNotice('Drop video or images on a video track, and audio on an audio track.')
      return
    }
    const endFrame = Math.max(0, ...project.clips.filter((clip) => clip.trackId === track.id).map((clip) => clip.startFrame + clip.durationFrames))
    const startFrame = startAt ?? endFrame
    const clip = createClip(asset, track.id, startFrame)
    if (asset.kind === 'video' && track.kind === 'video') {
      const linkGroupId = crypto.randomUUID()
      const videoClip = { ...clip, linkGroupId }
      const audioClip = { ...createClip(asset, 'a1', startFrame), linkGroupId }
      apply({ type: 'add-clips', clips: [videoClip, audioClip] })
      setSelectedClipId(videoClip.id)
    } else {
      apply({ type: 'add-clip', clip })
      setSelectedClipId(clip.id)
    }
    seekTo(startFrame)
  }

  async function importFiles(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      const existing = project.assets.find((asset) => asset.name === file.name && asset.fileSize === file.size && asset.modifiedAt === file.lastModified)
      if (existing) {
        setNotice(`${file.name} is already in this project.`)
        continue
      }
      try {
        const asset = await readMedia(file, project)
        await storeMedia(asset.id, file)
        const url = URL.createObjectURL(file)
        setMediaUrls((current) => ({ ...current, [asset.id]: url }))
        apply({ type: 'add-asset', asset })
        setNotice(`${file.name} imported. Add it to a track to begin editing.`)
      } catch (error) {
        setNotice(error instanceof Error ? `${file.name}: ${error.message}` : `${file.name} could not be imported.`)
      }
    }
  }

  function onMediaFiles(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) void importFiles(event.target.files)
    event.target.value = ''
  }

  function splitSelected(clipId = selectedClipId) {
    const clip = project.clips.find((item) => item.id === clipId)
    if (!clip || playhead <= clip.startFrame || playhead >= clip.startFrame + clip.durationFrames) {
      setNotice('Place the playhead inside a selected clip to split it.')
      return
    }
    const rightId = crypto.randomUUID()
    const linked = clip.linkGroupId ? project.clips.filter((item) => item.linkGroupId === clip.linkGroupId) : [clip]
    const rightClipIds = Object.fromEntries(linked.filter((item) => item.id !== clip.id).map((item) => [item.id, crypto.randomUUID()]))
    apply({ type: 'split-clip', clipId: clip.id, atFrame: playhead, rightClipId: rightId, rightClipIds })
    setSelectedClipId(rightId)
  }

  function deleteSelected() {
    if (!selectedClipId) return
    apply({ type: 'delete-clip', clipId: selectedClipId })
    setSelectedClipId(null)
  }

  function adjustTrim(edge: 'in' | 'out', delta: number) {
    if (!selectedClip) return
    const target = edge === 'in' ? selectedClip.startFrame + delta : selectedClip.startFrame + selectedClip.durationFrames + delta
    apply({ type: 'trim-clip', clipId: selectedClip.id, edge, atFrame: target })
    if (edge === 'in' && playhead < target) seekTo(target)
  }

  async function startExport() {
    const safeName = exportName.replace(/[\\/:*?"<>|]/g, '-').trim()
    if (!safeName) {
      setExportError('Enter a filename for the export.')
      return
    }
    const dimensions = exportPreset === '720p' ? { width: 1280, height: 720 }
      : exportPreset === '1080p' ? { width: 1920, height: 1080 }
        : exportPreset === 'vertical' ? { width: 1080, height: 1920 }
          : { width: project.width, height: project.height }
    const renderProject = { ...project, ...dimensions }
    const controller = new AbortController()
    exportAbort.current = controller
    setExportStage('preparing')
    setExportProgress(0)
    setExportError('')
    try {
      const blob = await renderWebm(renderProject, mediaUrls, { audioOnly: exportAudioOnly, bitrate: exportBitrate }, (stage, progress) => {
        setExportStage(stage)
        setExportProgress(progress)
      }, controller.signal)
      const objectUrl = URL.createObjectURL(blob)
      try {
        const probe = document.createElement(exportAudioOnly ? 'audio' : 'video')
        probe.preload = 'metadata'
        probe.src = objectUrl
        await new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => reject(new Error('The rendered WebM did not become readable in time.')), 10_000)
          probe.onloadedmetadata = () => { clearTimeout(timeout); resolve() }
          probe.onerror = () => { clearTimeout(timeout); reject(new Error('The rendered WebM could not be decoded for validation.')) }
        })
        if (!Number.isFinite(probe.duration)) {
          await new Promise<void>((resolve) => {
            const timeout = window.setTimeout(resolve, 2_000)
            probe.addEventListener('durationchange', () => { clearTimeout(timeout); resolve() }, { once: true })
            try { probe.currentTime = Number.MAX_SAFE_INTEGER } catch { clearTimeout(timeout); resolve() }
          })
        }
        if (!Number.isFinite(probe.duration) || Math.abs(probe.duration - framesToSeconds(sequenceEnd, project.frameRate)) > 1) {
          throw new Error(`Rendered duration ${Number.isFinite(probe.duration) ? probe.duration.toFixed(2) : 'unknown'} s does not match sequence duration ${framesToSeconds(sequenceEnd, project.frameRate).toFixed(2)} s (output ${blob.size} bytes). Export was not saved.`)
        }
        if (!exportAudioOnly && !(probe as HTMLVideoElement).videoWidth) throw new Error('The rendered file has no decodable video stream.')
        const anchor = document.createElement('a')
        anchor.href = objectUrl
        anchor.download = safeName.toLowerCase().endsWith('.webm') ? safeName : `${safeName}.webm`
        anchor.click()
        setNotice(`Export completed and validated · ${blob.type} · ${(blob.size / 1_048_576).toFixed(1)} MB`)
        setExportStage('completed')
      } finally {
        URL.revokeObjectURL(objectUrl)
      }
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        setExportStage('cancelled')
        setExportError('Export cancelled. Incomplete output was discarded.')
      } else {
        setExportStage('failed')
        setExportError(error instanceof Error ? error.message : 'Export failed for an unknown reason.')
      }
    } finally {
      exportAbort.current = null
    }
  }

  function saveProject() {
    const contents = JSON.stringify(project, null, 2)
    const url = URL.createObjectURL(new Blob([contents], { type: 'application/vnd.vantacut.project+json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${project.name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Untitled sequence'}.vcut`
    anchor.click()
    URL.revokeObjectURL(url)
    setIsDirty(false)
    setNotice('Project saved as a .vcut file. Source media remains in the local browser cache.')
  }

  async function openProject(file: File) {
    if (isDirty && !window.confirm('This project has unsaved changes. Open another project?')) return
    try {
      const parsed: unknown = JSON.parse(await file.text())
      if (!isProject(parsed)) throw new Error('This is not a supported VantaCut project.')
      const entries = await Promise.all(parsed.assets.map(async (asset) => {
        const blob = await loadMedia(asset.id)
        return blob ? [asset.id, URL.createObjectURL(blob)] as const : null
      }))
      setMediaUrls(Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry !== null)))
      setHistory({ past: [], present: parsed, future: [] })
      setSelectedClipId(null)
      setPlayhead(0)
      setIsDirty(false)
      const missing = parsed.assets.filter((asset) => !entries.some((entry) => entry?.[0] === asset.id))
      setNotice(missing.length ? `Opened project with ${missing.length} source file${missing.length === 1 ? '' : 's'} missing from this browser.` : 'Project opened.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not open the project file.')
    }
  }

  function newProject() {
    if (isDirty && !window.confirm('This project has unsaved changes. Create a new sequence?')) return
    Object.values(mediaUrls).forEach(URL.revokeObjectURL)
    setMediaUrls({})
    setHistory(defaultHistory())
    setSelectedClipId(null)
    setPlayhead(0)
    setIsDirty(false)
    setNotice('New 1080p, 24 fps sequence created.')
  }

  function updateSelected(values: Partial<Pick<Clip, 'brightness' | 'contrast' | 'saturation' | 'opacity' | 'volume' | 'muted' | 'enabled' | 'linkGroupId'>>) {
    if (selectedClip) apply({ type: 'update-clip', clipId: selectedClip.id, values })
  }

  function updateTrack(track: Track, values: Partial<Pick<Track, 'name' | 'locked' | 'muted' | 'solo' | 'hidden'>>) {
    apply({ type: 'update-track', trackId: track.id, values })
  }

  function onContextMenu(event: MouseEvent, kind: ContextTarget['kind'], id: string) {
    if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return
    if (event.button !== 2) return
    event.preventDefault()
    setContextTarget(kind === 'ruler'
      ? { kind: 'ruler', id: 'sequence', x: event.clientX, y: event.clientY }
      : { kind, id, x: event.clientX, y: event.clientY } as ContextTarget)
  }

  function pasteClips() {
    if (!clipboard.length) return
    const origin = Math.min(...clipboard.map((clip) => clip.startFrame))
    const linkIds = new Map<string, string>()
    const copies = clipboard.map((clip) => {
      const linkGroupId = clip.linkGroupId ? (linkIds.get(clip.linkGroupId) ?? crypto.randomUUID()) : undefined
      if (clip.linkGroupId && linkGroupId) linkIds.set(clip.linkGroupId, linkGroupId)
      return { ...clip, id: crypto.randomUUID(), startFrame: Math.max(0, playhead + clip.startFrame - origin), linkGroupId }
    })
    apply({ type: 'add-clips', clips: copies })
    setSelectedClipId(copies[0]?.id ?? null)
  }

  function runContextAction(action: string) {
    const target = contextTarget
    setContextTarget(null)
    if (!target) return
    if (target.kind === 'clip') {
      const clip = project.clips.find((item) => item.id === target.id)
      if (!clip) return
      const group = clip.linkGroupId ? project.clips.filter((item) => item.linkGroupId === clip.linkGroupId) : [clip]
      if (action === 'clip-select') setSelectedClipId(clip.id)
      else if (action === 'clip-copy') setClipboard(group)
      else if (action === 'clip-cut') { setClipboard(group); apply({ type: 'delete-clip', clipId: clip.id }); setSelectedClipId(null) }
      else if (action === 'clip-paste') pasteClips()
      else if (action === 'clip-duplicate') {
        const groupId = group.length > 1 ? crypto.randomUUID() : undefined
        const copies = group.map((item) => ({ ...item, id: crypto.randomUUID(), startFrame: item.startFrame + item.durationFrames, linkGroupId: groupId }))
        apply({ type: 'add-clips', clips: copies })
        setSelectedClipId(copies.find((item) => project.tracks.find((track) => track.id === item.trackId)?.kind === 'video')?.id ?? copies[0]?.id ?? null)
      } else if (action === 'clip-split') splitSelected(clip.id)
      else if (action === 'clip-delete') { apply({ type: 'delete-clip', clipId: clip.id }); setSelectedClipId(null) }
      else if (action === 'clip-ripple') { apply({ type: 'ripple-delete', clipId: clip.id }); setSelectedClipId(null) }
      else if (action === 'clip-toggle') apply({ type: 'update-clip', clipId: clip.id, values: { enabled: clip.enabled === false } })
      else if (action === 'clip-unlink' && clip.linkGroupId) {
        for (const item of group) apply({ type: 'update-clip', clipId: item.id, values: { linkGroupId: undefined } })
      } else if (action === 'clip-properties') { setSelectedClipId(clip.id); seekTo(clip.startFrame) }
      return
    }
    if (target.kind === 'asset') {
      const asset = project.assets.find((item) => item.id === target.id)
      if (!asset) return
      if (action === 'asset-add') addAssetToTimeline(asset)
      else if (action === 'asset-rename') {
        const name = window.prompt('Rename media display name', asset.name)?.trim()
        if (name && name !== asset.name) apply({ type: 'update-asset', assetId: asset.id, values: { name } })
      } else if (action === 'asset-properties') setNotice(`${asset.name} · ${asset.kind} · ${(asset.fileSize / 1_048_576).toFixed(1)} MB · ${asset.width} × ${asset.height}`)
      else if (action === 'asset-remove' && !project.clips.some((clip) => clip.assetId === asset.id)) {
        apply({ type: 'remove-asset', assetId: asset.id })
        const url = mediaUrls[asset.id]
        if (url) URL.revokeObjectURL(url)
        setMediaUrls((current) => { const next = { ...current }; delete next[asset.id]; return next })
      }
      return
    }
    if (target.kind === 'track') {
      const track = project.tracks.find((item) => item.id === target.id)
      if (!track) return
      if (action === 'track-lock') updateTrack(track, { locked: !track.locked })
      else if (action === 'track-mute') updateTrack(track, { muted: !track.muted })
      else if (action === 'track-solo') updateTrack(track, { solo: !track.solo })
      else if (action === 'track-toggle') updateTrack(track, { hidden: !track.hidden })
      else if (action === 'track-rename') {
        const name = window.prompt('Rename track', track.name)?.trim()
        if (name) updateTrack(track, { name })
      } else if (action === 'track-delete') {
        if (project.clips.some((clip) => clip.trackId === track.id) && !window.confirm(`Delete ${track.name} and its clips? Source media will remain untouched.`)) return
        apply({ type: 'remove-track', trackId: track.id })
      } else if (action === 'track-add-above' || action === 'track-add-below') {
        const index = project.tracks.findIndex((item) => item.id === track.id) + (action === 'track-add-below' ? 1 : 0)
        const siblings = project.tracks.filter((item) => item.kind === track.kind)
        const next: Track = { id: crypto.randomUUID(), name: `${track.kind === 'video' ? 'V' : 'A'}${siblings.length + 1}`, kind: track.kind, locked: false, muted: false, solo: false, hidden: false }
        apply({ type: 'add-track', track: next, index })
      }
      return
    }
    if (target.kind === 'lane') {
      if (action === 'lane-paste') pasteClips()
      else if (action === 'lane-add-video' || action === 'lane-add-audio') {
        const kind = action === 'lane-add-video' ? 'video' : 'audio'
        const siblings = project.tracks.filter((track) => track.kind === kind)
        apply({ type: 'add-track', track: { id: crypto.randomUUID(), name: `${kind === 'video' ? 'V' : 'A'}${siblings.length + 1}`, kind, locked: false, muted: false, solo: false, hidden: false } })
      }
      return
    }
    if (action === 'ruler-start') seekTo(0)
    else if (action === 'ruler-end') seekTo(sequenceEnd)
    else if (action === 'ruler-play') togglePlayback()
  }

  function onTimelineDrop(event: DragEvent<HTMLDivElement>, track: Track) {
    event.preventDefault()
    setDragOver(false)
    const bounds = event.currentTarget.getBoundingClientRect()
    let frame = Math.max(0, Math.round((event.clientX - bounds.left + event.currentTarget.scrollLeft) / zoom))
    const clipId = event.dataTransfer.getData('application/x-vantacut-clip')
    const assetId = event.dataTransfer.getData('application/x-vantacut-asset')
    if (snapping) {
      const snapDistance = Math.max(1, Math.round(8 / zoom))
      const targets = [playhead, ...project.clips.filter((clip) => clip.id !== clipId).flatMap((clip) => [clip.startFrame, clip.startFrame + clip.durationFrames])]
      const nearest = targets.reduce((best, target) => Math.abs(target - frame) < Math.abs(best - frame) ? target : best, frame)
      if (Math.abs(nearest - frame) <= snapDistance) frame = nearest
    }
    if (clipId) {
      const clip = project.clips.find((item) => item.id === clipId)
      const asset = clip && project.assets.find((item) => item.id === clip.assetId)
      if (!clip || !asset || track.locked || (track.kind === 'audio') !== (asset.kind === 'audio')) {
        setNotice('This clip cannot be moved to the selected track.')
        return
      }
      apply({ type: 'move-clip', clipId, startFrame: frame, trackId: track.id })
      setSelectedClipId(clipId)
    } else if (assetId) {
      const asset = project.assets.find((item) => item.id === assetId)
      if (asset) addAssetToTimeline(asset, track.id, frame)
    }
  }

  function onProjectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (file) void openProject(file)
    event.target.value = ''
  }

  return (
    <main className="studio-shell">
      <header className="appbar">
        <div className="brand-lockup">
          <div className="brand-mark"><Clapperboard size={17} strokeWidth={2.2} /></div>
          <span className="brand-name">VantaCut</span>
          <span className="brand-divider" />
          <span className="workspace-label">STUDIO</span>
        </div>
        <div className="project-tools">
          <button className="text-action" type="button" onClick={newProject}>New</button>
          <button className="icon-action" type="button" title="Open project" aria-label="Open project" onClick={() => projectInputRef.current?.click()}><FolderOpen size={16} /></button>
          <button className="icon-action" type="button" title="Save .vcut project" aria-label="Save project" onClick={saveProject}><Download size={16} /></button>
          <span className="toolbar-divider" />
          <button className="icon-action" type="button" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!canUndo} onClick={handleUndo}><Undo2 size={16} /></button>
          <button className="icon-action" type="button" title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!canRedo} onClick={handleRedo}><Redo2 size={16} /></button>
        </div>
        <div className="project-status">
          <span className={`save-state ${isDirty ? 'is-dirty' : ''}`}><span className="status-dot" />{isDirty ? 'Unsaved edits' : 'Autosaved'}</span>
          <button className="export-button" type="button" onClick={() => { setExportName(`${project.name}.webm`); setExportAudioOnly(!project.clips.some((clip) => project.tracks.some((track) => track.id === clip.trackId && track.kind === 'video'))); setExportStage(null); setExportError(''); setShowExportInfo(true) }}><Download size={15} />Export</button>
        </div>
        <input ref={projectInputRef} className="visually-hidden" type="file" accept=".vcut,application/json" onChange={onProjectFile} />
      </header>

      <section className="sequence-bar">
        <div className="sequence-name-wrap">
          <input key={project.id} aria-label="Sequence name" defaultValue={project.name} onBlur={(event) => {
            const name = event.currentTarget.value.trim() || 'Untitled sequence'
            if (name !== project.name) apply({ type: 'rename-project', name })
          }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />
          <ChevronDown size={14} />
        </div>
        <div className="sequence-meta"><span>1920 × 1080</span><i /> <span>24 fps</span><i /><span>Rec. 709</span></div>
        <div className="sequence-right"><span className="cache-indicator"><span />LOCAL MEDIA</span><button type="button" className="quiet-button" onClick={() => setNotice('Project recovery is stored in this browser. Source files remain on your device.')} title="Recovery status"><Clock3 size={14} /></button></div>
      </section>

      <div className="workspace-grid">
        <aside className="media-panel panel">
          <div className="panel-heading"><div className="panel-tabs"><button type="button" className={leftTab === 'media' ? 'active' : ''} onClick={() => setLeftTab('media')}>Media</button><button type="button" className={leftTab === 'effects' ? 'active' : ''} onClick={() => setLeftTab('effects')}>Effects</button></div><button className="icon-action compact" type="button" title="Import media" aria-label="Import media" onClick={() => mediaInputRef.current?.click()}><Plus size={16} /></button></div>
          {leftTab === 'media' ? <>
            <div className="bin-toolbar"><span className="bin-title">PROJECT BIN <span>{project.assets.length}</span></span><button type="button" className="icon-action compact" aria-label="Search media" title="Search media"><Search size={15} /></button></div>
            <label className="search-box"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search media" /></label>
            <div className={`asset-list ${dragOver ? 'drag-active' : ''}`} onContextMenu={(event) => { const row = (event.target as HTMLElement).closest<HTMLElement>('[data-context-asset]'); if (row?.dataset.contextAsset) onContextMenu(event, 'asset', row.dataset.contextAsset) }} onDragOver={(event) => { event.preventDefault(); setDragOver(true) }} onDragLeave={() => setDragOver(false)} onDrop={(event) => { event.preventDefault(); setDragOver(false); if (event.dataTransfer.files.length) void importFiles(event.dataTransfer.files) }}>
              {filteredAssets.map((asset) => <div className="asset-row" data-context-asset={asset.id} key={asset.id} draggable onDragStart={(event) => event.dataTransfer.setData('application/x-vantacut-asset', asset.id)}>
                <div className="asset-thumb">{asset.thumbnail ? <img src={asset.thumbnail} alt="" /> : iconForAsset(asset.kind)}</div>
                <div className="asset-info"><span className="asset-name" title={asset.name}>{asset.name}</span><span className="asset-meta">{asset.width && asset.height ? `${asset.width} × ${asset.height}` : asset.kind.toUpperCase()} <i /> {formatDuration(asset.durationFrames, project)}</span></div>
                <button className="asset-add" type="button" aria-label={`Add ${asset.name} to timeline`} title="Add to timeline" onClick={() => addAssetToTimeline(asset)}><Plus size={15} /></button>
              </div>)}
              {!project.assets.length && <div className="empty-bin"><div className="empty-bin-icon"><FolderOpen size={20} /></div><strong>Bring in your footage</strong><span>Video, audio, and still images stay on this device.</span><button type="button" className="outline-button" onClick={() => mediaInputRef.current?.click()}><Plus size={14} />Import media</button></div>}
              {!!project.assets.length && !filteredAssets.length && <div className="empty-search">No media matches “{search}”.</div>}
            </div>
            <div className="panel-footnote"><span className="footnote-dot" />Media cached locally in this browser</div>
          </> : <div className="effects-pane"><div className="effects-title"><Sparkles size={16} /><span>Image adjustments</span></div><p>Select a clip to adjust brightness, contrast, saturation, and opacity in the inspector.</p><button type="button" className="effect-link" onClick={() => selectedClip && document.getElementById('inspector-brightness')?.focus()}><SlidersHorizontal size={14} />Open clip inspector</button></div>}
          <input ref={mediaInputRef} className="visually-hidden" type="file" accept="video/*,audio/*,image/*" multiple onChange={onMediaFiles} />
        </aside>

        <section className="monitor-panel panel">
          <div className="panel-heading monitor-heading"><span className="panel-title">SOURCE / PROGRAM</span><div className="monitor-tools"><span className="monitor-resolution">FIT</span><button className="icon-action compact" type="button" aria-label="Preview display options" title="Preview uses source aspect ratio with contain scaling" onClick={() => setNotice('Preview uses the source aspect ratio with contain scaling.')}><Eye size={15} /></button></div></div>
          <div className="monitor-stage">
            {activeUrl && activeAsset?.kind === 'video' && <video ref={videoRef} className="preview-video" playsInline muted onLoadedData={(event) => {
              const video = event.currentTarget
              const frameCanvas = document.createElement('canvas')
              frameCanvas.width = Math.min(video.videoWidth, 480)
              frameCanvas.height = Math.round((frameCanvas.width * video.videoHeight) / video.videoWidth)
              frameCanvas.getContext('2d')?.drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height)
              const thumbnail = frameCanvas.toDataURL('image/jpeg', 0.72)
              const asset = project.assets.find((item) => item.id === activeClip?.assetId)
              if (asset && !asset.thumbnail && thumbnail.length < 250_000) apply({ type: 'update-asset', assetId: asset.id, values: { thumbnail } })
            }} style={{ filter: selectedClip && selectedClip.id === activeClip?.id ? `brightness(${100 + selectedClip.brightness}%) contrast(${100 + selectedClip.contrast}%) saturate(${100 + selectedClip.saturation}%)` : undefined, opacity: selectedClip && selectedClip.id === activeClip?.id ? selectedClip.opacity : 1 }} />}
            {activeUrl && activeAsset?.kind === 'image' && <img className="preview-image" src={activeUrl} alt={activeAsset.name} style={{ filter: selectedClip && selectedClip.id === activeClip?.id ? `brightness(${100 + selectedClip.brightness}%) contrast(${100 + selectedClip.contrast}%) saturate(${100 + selectedClip.saturation}%)` : undefined, opacity: selectedClip && selectedClip.id === activeClip?.id ? selectedClip.opacity : 1 }} />}
            {(!activeUrl || activeAsset?.kind === 'audio') && <div className="monitor-empty"><div className="monitor-brand"><Clapperboard size={22} /></div><span className="monitor-empty-title">{activeAsset?.kind === 'audio' ? 'Audio clip selected' : project.assets.length ? 'No video at playhead' : 'VANTACUT STUDIO'}</span><span className="monitor-empty-copy">{activeAsset?.kind === 'audio' ? 'Audio playback is not available in this preview.' : project.assets.length ? 'Move the playhead over a video clip to preview.' : 'A local editing workspace for your next cut.'}</span></div>}
            <div className="monitor-corner top-left"><span>PROGRAM</span></div><div className="monitor-corner top-right"><span>1080P</span><i /></div>
          </div>
          <div className="monitor-transport"><div className="time-readout"><span>{formatTimecode(playhead, project.frameRate)}</span><span className="time-separator">/</span><span className="time-total">{formatTimecode(duration, project.frameRate)}</span></div><div className="transport-controls"><button type="button" className="step-button" title="Previous frame" aria-label="Previous frame" onClick={() => seekTo(Math.max(0, playhead - 1))}><Minus size={13} /></button><button type="button" className="play-button" title={isPlaying ? 'Pause' : 'Play'} aria-label={isPlaying ? 'Pause' : 'Play'} onClick={togglePlayback}>{isPlaying ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button><button type="button" className="step-button" title="Next frame" aria-label="Next frame" onClick={() => seekTo(Math.min(duration, playhead + 1))}><Plus size={13} /></button></div><div className="preview-quality">FULL <ChevronDown size={12} /></div></div>
        </section>

        <aside className="inspector-panel panel">
          <div className="panel-heading inspector-heading"><span className="panel-title">INSPECTOR</span><SlidersHorizontal size={15} /></div>
          {selectedClip && selectedAsset ? <div className="inspector-content">
            <div className="inspector-media"><div className="inspector-thumb">{selectedAsset.thumbnail ? <img src={selectedAsset.thumbnail} alt="" /> : iconForAsset(selectedAsset.kind)}</div><div className="inspector-label"><strong>{selectedAsset.name}</strong><span>{selectedAsset.kind} · {formatDuration(selectedClip.durationFrames, project)}</span></div><button className="icon-action compact" type="button" title="Delete selected clip" aria-label="Delete selected clip" onClick={deleteSelected}><Trash2 size={15} /></button></div>
            {selectedTrack?.kind === 'audio' ? <div className="inspector-section"><div className="section-label">AUDIO</div><div className="audio-inspector-state"><AudioLines size={14} /><span>{selectedClip.muted ? 'Clip muted' : 'Clip audio enabled'}</span><button className="quiet-button" type="button" aria-label={selectedClip.muted ? 'Unmute clip' : 'Mute clip'} title={selectedClip.muted ? 'Unmute clip' : 'Mute clip'} onClick={() => updateSelected({ muted: !selectedClip.muted })}>{selectedClip.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}</button></div><label className="slider-control"><span>Clip gain<output>{Math.round(selectedClip.volume * 100)}%</output></span><input aria-label="Clip gain" type="range" min="0" max="100" value={Math.round(selectedClip.volume * 100)} onChange={(event) => updateSelected({ volume: Number(event.target.value) / 100 })} /></label><p className="transform-note">Gain is applied by the active browser decoder.</p></div> : <><div className="inspector-section"><div className="section-label">TRANSFORM</div><p className="transform-note">Position and scale are not available in this build.</p></div><div className="inspector-section"><div className="section-label">IMAGE ADJUSTMENTS</div>{([['brightness', 'Brightness', -100, 100], ['contrast', 'Contrast', -100, 100], ['saturation', 'Saturation', -100, 100]] as const).map(([key, label, min, max]) => <label className="slider-control" key={key}><span>{label}<output>{selectedClip[key]}</output></span><input id={key === 'brightness' ? 'inspector-brightness' : undefined} type="range" min={min} max={max} value={selectedClip[key]} onChange={(event) => updateSelected({ [key]: Number(event.target.value) })} /></label>)}<label className="slider-control"><span>Opacity<output>{Math.round(selectedClip.opacity * 100)}%</output></span><input type="range" min="0" max="100" value={Math.round(selectedClip.opacity * 100)} onChange={(event) => updateSelected({ opacity: Number(event.target.value) / 100 })} /></label></div></>}
            <div className="inspector-section clip-timing"><div className="section-label">CLIP TIMING</div><div className="timing-pair"><div><span>START</span><strong>{formatTimecode(selectedClip.startFrame, project.frameRate)}</strong></div><div><span>DURATION</span><strong>{formatTimecode(selectedClip.durationFrames, project.frameRate)}</strong></div></div><div className="trim-actions"><button type="button" onClick={() => adjustTrim('in', 1)} title="Trim in by one frame">In +1f</button><button type="button" onClick={() => adjustTrim('in', -1)} title="Extend in by one frame">In −1f</button><button type="button" onClick={() => adjustTrim('out', -1)} title="Trim out by one frame">Out −1f</button><button type="button" onClick={() => adjustTrim('out', 1)} title="Extend out by one frame">Out +1f</button></div></div>
          </div> : <div className="inspector-empty"><div className="inspector-empty-mark"><SlidersHorizontal size={18} /></div><strong>Nothing selected</strong><span>Select a clip on the timeline to inspect its properties.</span></div>}
        </aside>

        <section className="timeline-panel panel">
          <div className="timeline-toolbar"><div className="timeline-tools-left"><span className="panel-title">TIMELINE</span><span className="timeline-separator" /><button className="tool-action" type="button" title="Split selected clip at playhead (S)" onClick={() => splitSelected()}><Scissors size={15} /><span>Split</span></button><button className="tool-action" type="button" title="Delete selected clip" disabled={!selectedClip} onClick={deleteSelected}><Trash2 size={15} /></button></div><div className="timeline-tools-right"><button className={`snap-toggle ${snapping ? 'enabled' : ''}`} type="button" aria-pressed={snapping} onClick={() => setSnapping((value) => !value)} title="Snap clip edges to the playhead and other clip edges"><span />SNAP</button><button className="icon-action compact" type="button" title="Zoom out" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(1, value - 0.5))}><ZoomOut size={15} /></button><input aria-label="Timeline zoom" type="range" min="1" max="7" step="0.5" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /><button className="icon-action compact" type="button" title="Zoom in" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(7, value + 0.5))}><ZoomIn size={15} /></button></div></div>
          <div className="timeline-scroller" onContextMenu={(event) => {
            const target = event.target as HTMLElement
            const clip = target.closest<HTMLElement>('[data-context-clip]')
            const track = target.closest<HTMLElement>('[data-context-track]')
            const lane = target.closest<HTMLElement>('[data-context-lane]')
            const ruler = target.closest<HTMLElement>('[data-context-ruler]')
            if (clip?.dataset.contextClip) onContextMenu(event, 'clip', clip.dataset.contextClip)
            else if (track?.dataset.contextTrack) onContextMenu(event, 'track', track.dataset.contextTrack)
            else if (lane?.dataset.contextLane) onContextMenu(event, 'lane', lane.dataset.contextLane)
            else if (ruler) onContextMenu(event, 'ruler', 'sequence')
          }} onDragOver={(event) => event.preventDefault()}>
            <div className="timeline-ruler-row"><div className="track-gutter ruler-gutter" data-context-ruler="sequence"><span>SEQ 01</span></div><div className="timeline-ruler" data-context-ruler="sequence" style={{ width: Math.max(1100, duration * zoom) }} onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); seekTo((event.clientX - bounds.left) / zoom) }}>{Array.from({ length: Math.ceil(duration / (Math.round(framesPerSecond(project)) * 5)) + 1 }, (_, index) => index * Math.round(framesPerSecond(project)) * 5).map((frame) => <span className="ruler-mark" key={frame} style={{ left: frame * zoom }}><i />{formatDuration(frame, project)}</span>)}<div className="playhead-ruler" style={{ left: playhead * zoom }} /></div></div>
            <div className="tracks-area" style={{ width: Math.max(1100, duration * zoom) }}>
              {project.tracks.map((track) => <div className={`track-row ${track.kind === 'audio' ? 'audio-track' : ''}`} key={track.id}>
                <div className="track-gutter" data-context-track={track.id}><span className="track-name">{track.name}</span><span className="track-kind">{track.kind === 'video' ? 'VIDEO' : 'AUDIO'}</span><div className="track-controls"><button type="button" title={track.locked ? 'Unlock track' : 'Lock track'} aria-label={track.locked ? 'Unlock track' : 'Lock track'} onClick={() => updateTrack(track, { locked: !track.locked })}>{track.locked ? <LockKeyhole size={13} /> : <UnlockKeyhole size={13} />}</button><button type="button" title={track.kind === 'video' ? (track.hidden ? 'Show track' : 'Hide track') : (track.muted ? 'Unmute track' : 'Mute track')} aria-label={track.kind === 'video' ? (track.hidden ? 'Show track' : 'Hide track') : (track.muted ? 'Unmute track' : 'Mute track')} onClick={() => updateTrack(track, track.kind === 'video' ? { hidden: !track.hidden } : { muted: !track.muted })}>{track.kind === 'video' ? (track.hidden ? <EyeOff size={13} /> : <Eye size={13} />) : (track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />)}</button>{track.kind === 'audio' && <button type="button" title={track.solo ? 'Unsolo track' : 'Solo track'} aria-label={track.solo ? 'Unsolo track' : 'Solo track'} onClick={() => updateTrack(track, { solo: !track.solo })}>{track.solo ? <Volume2 size={13} color="#c8ef6b" /> : <Volume2 size={13} />}</button>}</div></div>
                <div className={`track-lane ${track.locked ? 'is-locked' : ''}`} data-context-lane={track.id} style={{ width: Math.max(1100, duration * zoom) }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => onTimelineDrop(event, track)} onClick={(event) => { if (event.target === event.currentTarget) seekTo(Math.round((event.nativeEvent.offsetX) / zoom)) }}>
                  {project.clips.filter((clip) => clip.trackId === track.id).map((clip) => {
                    const asset = project.assets.find((item) => item.id === clip.assetId)
                    if (!asset) return null
                    return <div className={`timeline-clip ${track.kind === 'audio' ? 'clip-audio' : 'clip-video'} ${selectedClipId === clip.id ? 'selected' : ''} ${clip.enabled === false ? 'clip-disabled' : ''} ${asset.kind === 'image' ? 'clip-image' : ''}`} data-context-clip={clip.id} key={clip.id} style={{ left: clip.startFrame * zoom, width: Math.max(clip.durationFrames * zoom, 26) }} draggable={!track.locked} onDragStart={(event) => event.dataTransfer.setData('application/x-vantacut-clip', clip.id)} onClick={(event) => { event.stopPropagation(); setSelectedClipId(clip.id); seekTo(clip.startFrame) }}>
                      {asset.thumbnail && <div className="clip-thumbnails" style={{ backgroundImage: `url(${asset.thumbnail})` }} />}
                      <span className="clip-label">{track.kind === 'audio' ? <AudioLines size={12} /> : iconForAsset(asset.kind)}{asset.name}</span>
                    </div>
                  })}
                  <div className="playhead-line" style={{ left: playhead * zoom }}><i /></div>
                  {!project.clips.some((clip) => clip.trackId === track.id) && <span className="lane-empty">Drop {track.kind === 'video' ? 'video or images' : 'audio'} here</span>}
                </div>
              </div>)}
              {project.clips.filter((clip) => project.tracks.some((track) => track.id === clip.trackId && track.kind === 'audio')).map((clip) => {
                const url = mediaUrls[clip.assetId]
                if (!url) return null
                const asset = project.assets.find((item) => item.id === clip.assetId)
                return <audio className="audio-source" key={clip.id} ref={(element) => {
                  if (element) audioRefs.current.set(clip.id, element)
                  else audioRefs.current.delete(clip.id)
                }} src={url} preload="auto" onError={() => setNotice(`Could not decode audio for ${asset?.name ?? 'this clip'}. Try a browser-supported WAV, MP3, or AAC source.`)} />
              })}
            </div>
          </div>
          <div className="timeline-status"><span>{project.clips.length} clip{project.clips.length === 1 ? '' : 's'}</span><i /><span>{project.tracks.length} tracks</span><span className="timeline-status-right">{formatTimecode(playhead, project.frameRate)} <span>·</span> {Math.round(zoom * 100 / pxPerFrameDefault)}%</span></div>
        </section>
      </div>

      <footer className="statusbar"><div className="statusbar-left"><span className="ready-check"><Check size={11} /></span><span>{notice || 'Ready'}</span></div><div className="statusbar-right"><span>LOCAL ONLY</span><i /> <span>24 FPS</span></div></footer>

      {showExportInfo && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !['preparing', 'rendering', 'finalizing'].includes(exportStage ?? '')) setShowExportInfo(false) }}><section className="export-dialog export-workspace" role="dialog" aria-modal="true" aria-labelledby="export-title"><div className="dialog-top"><div className="dialog-icon"><Download size={18} /></div><button className="icon-action" type="button" aria-label="Close export dialog" disabled={['preparing', 'rendering', 'finalizing'].includes(exportStage ?? '')} onClick={() => setShowExportInfo(false)}><X size={17} /></button></div><h2 id="export-title">Export sequence</h2><p>Render enabled timeline clips to a local WebM download. Output uses the browser's available VP8 video and Opus audio encoders.</p>
        <label className="export-field">FILE NAME<input aria-label="Output filename" value={exportName} disabled={['preparing', 'rendering', 'finalizing'].includes(exportStage ?? '')} onChange={(event) => setExportName(event.target.value)} /></label>
        <div className="export-grid"><label className="export-field">CONTAINER<input value="WebM" readOnly /></label><label className="export-field">CODECS<input value={exportAudioOnly ? 'Opus audio' : 'VP8 + Opus'} readOnly /></label></div>
        {!exportAudioOnly && <label className="export-field">OUTPUT SIZE<select aria-label="Output resolution" value={exportPreset} onChange={(event) => setExportPreset(event.target.value as typeof exportPreset)}><option value="source">Source sequence · {project.width} × {project.height}</option><option value="720p">720p · 1280 × 720</option><option value="1080p">1080p · 1920 × 1080</option><option value="vertical">Vertical · 1080 × 1920</option></select></label>}
        {!exportAudioOnly && <label className="export-field">VIDEO QUALITY<select aria-label="Video quality" value={exportBitrate} onChange={(event) => setExportBitrate(Number(event.target.value))}><option value={4500000}>Smaller file · 4.5 Mbps</option><option value={8000000}>Balanced · 8 Mbps</option><option value={16000000}>High quality · 16 Mbps</option></select></label>}
        <label className="export-check"><input type="checkbox" checked={exportAudioOnly} disabled={['preparing', 'rendering', 'finalizing'].includes(exportStage ?? '')} onChange={(event) => setExportAudioOnly(event.target.checked)} /><span>Audio-only export</span></label>
        <div className="export-summary"><span>ESTIMATED DURATION</span><strong>{formatDuration(sequenceEnd, project)}</strong><span>ESTIMATED SIZE</span><strong>~{Math.max(0.1, ((framesToSeconds(sequenceEnd, project.frameRate) * (exportAudioOnly ? 192_000 : exportBitrate + 192_000)) / 8 / 1_048_576)).toFixed(1)} MB</strong><span>DESTINATION</span><strong>Browser download folder</strong></div>
        {['preparing', 'rendering', 'finalizing'].includes(exportStage ?? '') && <div className="export-progress"><div className="export-progress-label"><span>{exportStage === 'preparing' ? 'Preparing media' : exportStage === 'finalizing' ? 'Finalizing and validating' : 'Rendering timeline'}</span><strong>{Math.round(exportProgress * 100)}%</strong></div><progress max="1" value={exportProgress} /></div>}
        {exportError && <p className="export-error" role="alert">{exportError}</p>}
        {exportStage === 'completed' && <p className="export-success" role="status">Export finished and passed browser media validation.</p>}
        <div className="dialog-actions">{['preparing', 'rendering', 'finalizing'].includes(exportStage ?? '') ? <button className="dialog-secondary" type="button" onClick={() => exportAbort.current?.abort()}>Cancel Export</button> : <button className="dialog-secondary" type="button" onClick={() => setShowExportInfo(false)}>{exportStage === 'completed' ? 'Done' : 'Close'}</button>}{exportStage !== 'completed' && <button className="dialog-primary" type="button" disabled={['preparing', 'rendering', 'finalizing'].includes(exportStage ?? '') || !sequenceEnd} onClick={() => void startExport()}><Download size={14} />Start Export</button>}</div></section></div>}
      {contextTarget && contextItems.length > 0 && <EditorContextMenu x={contextTarget.x} y={contextTarget.y} items={contextItems} onAction={runContextAction} onClose={() => setContextTarget(null)} />}
    </main>
  )
}

export default App
