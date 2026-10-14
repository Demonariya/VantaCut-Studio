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
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
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
import './App.css'

const recoveryKey = 'vantacut-recovery-v1'
const framesPerSecond = (project: Project) => project.frameRate.numerator / project.frameRate.denominator
const defaultHistory = (): History => ({ past: [], present: createProject(), future: [] })
const pxPerFrameDefault = 3

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
  const [search, setSearch] = useState('')
  const [zoom, setZoom] = useState(pxPerFrameDefault)
  const [snapping, setSnapping] = useState(true)
  const [leftTab, setLeftTab] = useState<'media' | 'effects'>('media')
  const [dragOver, setDragOver] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const mediaInputRef = useRef<HTMLInputElement>(null)
  const projectInputRef = useRef<HTMLInputElement>(null)

  const project = history.present
  const startupProject = useRef(project).current
  const selectedClip = project.clips.find((clip) => clip.id === selectedClipId)
  const duration = Math.max(sequenceDurationFrames(project), secondsToFrames(12, project.frameRate))
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
    setPlayhead(Math.max(0, Math.min(duration, Math.round(frame))))
    setSeekRevision((value) => value + 1)
  }

  function togglePlayback() {
    if (isPlaying) {
      videoRef.current?.pause()
      setIsPlaying(false)
      return
    }
    const clip = activeClip ?? project.clips.find((item) => item.trackId === 'v1')
    if (!clip) {
      setNotice('Add a video clip to V1 to start preview playback.')
      return
    }
    if (playhead >= clip.startFrame + clip.durationFrames) seekTo(clip.startFrame)
    setIsPlaying(true)
  }

  function addAssetToTimeline(asset: MediaAsset, trackId?: string, startAt?: number) {
    const track = project.tracks.find((item) => item.id === (trackId ?? (asset.kind === 'audio' ? 'a1' : 'v1')))
    if (!track || (track.kind === 'audio' && asset.kind !== 'audio') || (track.kind === 'video' && asset.kind === 'audio')) {
      setNotice('Drop video or images on a video track, and audio on an audio track.')
      return
    }
    const endFrame = Math.max(0, ...project.clips.filter((clip) => clip.trackId === track.id).map((clip) => clip.startFrame + clip.durationFrames))
    const clip = createClip(asset, track.id, startAt ?? endFrame)
    apply({ type: 'add-clip', clip })
    setSelectedClipId(clip.id)
    seekTo(clip.startFrame)
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

  function splitSelected() {
    const clip = project.clips.find((item) => item.id === selectedClipId)
    if (!clip || playhead <= clip.startFrame || playhead >= clip.startFrame + clip.durationFrames) {
      setNotice('Place the playhead inside a selected clip to split it.')
      return
    }
    const rightId = crypto.randomUUID()
    apply({ type: 'split-clip', clipId: clip.id, atFrame: playhead, rightClipId: rightId })
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

  function updateSelected(values: Partial<Pick<Clip, 'brightness' | 'contrast' | 'saturation' | 'opacity' | 'volume'>>) {
    if (selectedClip) apply({ type: 'update-clip', clipId: selectedClip.id, values })
  }

  function updateTrack(track: Track, values: Partial<Pick<Track, 'locked' | 'muted' | 'hidden'>>) {
    apply({ type: 'update-track', trackId: track.id, values })
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
          <button className="export-button" type="button" onClick={() => setShowExportInfo(true)}><Download size={15} />Export</button>
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
            <div className={`asset-list ${dragOver ? 'drag-active' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragOver(true) }} onDragLeave={() => setDragOver(false)} onDrop={(event) => { event.preventDefault(); setDragOver(false); if (event.dataTransfer.files.length) void importFiles(event.dataTransfer.files) }}>
              {filteredAssets.map((asset) => <div className="asset-row" key={asset.id} draggable onDragStart={(event) => event.dataTransfer.setData('application/x-vantacut-asset', asset.id)}>
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
            {activeUrl && activeAsset?.kind === 'video' && <video ref={videoRef} className="preview-video" playsInline onTimeUpdate={(event) => {
              const video = event.currentTarget
              if (!activeClip) return
              const sourceFrame = secondsToFrames(video.currentTime, project.frameRate)
              setPlayhead(Math.min(activeClip.startFrame + activeClip.durationFrames, activeClip.startFrame + sourceFrame - activeClip.sourceInFrame))
            }} onEnded={() => setIsPlaying(false)} onLoadedData={(event) => {
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
            <div className="inspector-section"><div className="section-label">TRANSFORM</div><p className="transform-note">Transform controls are not included in this build.</p></div>
            <div className="inspector-section"><div className="section-label">IMAGE ADJUSTMENTS</div>{([['brightness', 'Brightness', -100, 100], ['contrast', 'Contrast', -100, 100], ['saturation', 'Saturation', -100, 100]] as const).map(([key, label, min, max]) => <label className="slider-control" key={key}><span>{label}<output>{selectedClip[key]}</output></span><input id={key === 'brightness' ? 'inspector-brightness' : undefined} type="range" min={min} max={max} value={selectedClip[key]} onChange={(event) => updateSelected({ [key]: Number(event.target.value) })} /></label>)}<label className="slider-control"><span>Opacity<output>{Math.round(selectedClip.opacity * 100)}%</output></span><input type="range" min="0" max="100" value={Math.round(selectedClip.opacity * 100)} onChange={(event) => updateSelected({ opacity: Number(event.target.value) / 100 })} /></label></div>
            <div className="inspector-section clip-timing"><div className="section-label">CLIP TIMING</div><div className="timing-pair"><div><span>START</span><strong>{formatTimecode(selectedClip.startFrame, project.frameRate)}</strong></div><div><span>DURATION</span><strong>{formatTimecode(selectedClip.durationFrames, project.frameRate)}</strong></div></div><div className="trim-actions"><button type="button" onClick={() => adjustTrim('in', 1)} title="Trim in by one frame">In +1f</button><button type="button" onClick={() => adjustTrim('in', -1)} title="Extend in by one frame">In −1f</button><button type="button" onClick={() => adjustTrim('out', -1)} title="Trim out by one frame">Out −1f</button><button type="button" onClick={() => adjustTrim('out', 1)} title="Extend out by one frame">Out +1f</button></div></div>
          </div> : <div className="inspector-empty"><div className="inspector-empty-mark"><SlidersHorizontal size={18} /></div><strong>Nothing selected</strong><span>Select a clip on the timeline to inspect its properties.</span></div>}
        </aside>

        <section className="timeline-panel panel">
          <div className="timeline-toolbar"><div className="timeline-tools-left"><span className="panel-title">TIMELINE</span><span className="timeline-separator" /><button className="tool-action" type="button" title="Split selected clip at playhead (S)" onClick={splitSelected}><Scissors size={15} /><span>Split</span></button><button className="tool-action" type="button" title="Delete selected clip" disabled={!selectedClip} onClick={deleteSelected}><Trash2 size={15} /></button></div><div className="timeline-tools-right"><button className={`snap-toggle ${snapping ? 'enabled' : ''}`} type="button" aria-pressed={snapping} onClick={() => setSnapping((value) => !value)} title="Snap clip edges to the playhead and other clip edges"><span />SNAP</button><button className="icon-action compact" type="button" title="Zoom out" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(1, value - 0.5))}><ZoomOut size={15} /></button><input aria-label="Timeline zoom" type="range" min="1" max="7" step="0.5" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /><button className="icon-action compact" type="button" title="Zoom in" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(7, value + 0.5))}><ZoomIn size={15} /></button></div></div>
          <div className="timeline-scroller" onDragOver={(event) => event.preventDefault()}>
            <div className="timeline-ruler-row"><div className="track-gutter ruler-gutter"><span>SEQ 01</span></div><div className="timeline-ruler" style={{ width: Math.max(1100, duration * zoom) }} onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); seekTo((event.clientX - bounds.left) / zoom) }}>{Array.from({ length: Math.ceil(duration / (Math.round(framesPerSecond(project)) * 5)) + 1 }, (_, index) => index * Math.round(framesPerSecond(project)) * 5).map((frame) => <span className="ruler-mark" key={frame} style={{ left: frame * zoom }}><i />{formatDuration(frame, project)}</span>)}<div className="playhead-ruler" style={{ left: playhead * zoom }} /></div></div>
            <div className="tracks-area" style={{ width: Math.max(1100, duration * zoom) }}>
              {project.tracks.map((track) => <div className={`track-row ${track.kind === 'audio' ? 'audio-track' : ''}`} key={track.id}>
                <div className="track-gutter"><span className="track-name">{track.name}</span><span className="track-kind">{track.kind === 'video' ? 'VIDEO' : 'AUDIO'}</span><div className="track-controls"><button type="button" title={track.locked ? 'Unlock track' : 'Lock track'} aria-label={track.locked ? 'Unlock track' : 'Lock track'} onClick={() => updateTrack(track, { locked: !track.locked })}>{track.locked ? <LockKeyhole size={13} /> : <UnlockKeyhole size={13} />}</button><button type="button" title={track.kind === 'video' ? (track.hidden ? 'Show track' : 'Hide track') : (track.muted ? 'Unmute track' : 'Mute track')} aria-label={track.kind === 'video' ? (track.hidden ? 'Show track' : 'Hide track') : (track.muted ? 'Unmute track' : 'Mute track')} onClick={() => updateTrack(track, track.kind === 'video' ? { hidden: !track.hidden } : { muted: !track.muted })}>{track.kind === 'video' ? (track.hidden ? <EyeOff size={13} /> : <Eye size={13} />) : (track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />)}</button></div></div>
                <div className={`track-lane ${track.locked ? 'is-locked' : ''}`} style={{ width: Math.max(1100, duration * zoom) }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => onTimelineDrop(event, track)} onClick={(event) => { if (event.target === event.currentTarget) seekTo(Math.round((event.nativeEvent.offsetX) / zoom)) }}>
                  {project.clips.filter((clip) => clip.trackId === track.id).map((clip) => {
                    const asset = project.assets.find((item) => item.id === clip.assetId)
                    if (!asset) return null
                    return <div className={`timeline-clip ${track.kind === 'audio' ? 'clip-audio' : 'clip-video'} ${selectedClipId === clip.id ? 'selected' : ''} ${asset.kind === 'image' ? 'clip-image' : ''}`} key={clip.id} style={{ left: clip.startFrame * zoom, width: Math.max(clip.durationFrames * zoom, 26) }} draggable={!track.locked} onDragStart={(event) => event.dataTransfer.setData('application/x-vantacut-clip', clip.id)} onClick={(event) => { event.stopPropagation(); setSelectedClipId(clip.id); seekTo(clip.startFrame) }}>
                      {asset.thumbnail && <div className="clip-thumbnails" style={{ backgroundImage: `url(${asset.thumbnail})` }} />}
                      <span className="clip-label">{asset.kind === 'audio' ? <AudioLines size={12} /> : iconForAsset(asset.kind)}{asset.name}</span>
                    </div>
                  })}
                  <div className="playhead-line" style={{ left: playhead * zoom }}><i /></div>
                  {!project.clips.some((clip) => clip.trackId === track.id) && <span className="lane-empty">Drop {track.kind === 'video' ? 'video or images' : 'audio'} here</span>}
                </div>
              </div>)}
            </div>
          </div>
          <div className="timeline-status"><span>{project.clips.length} clip{project.clips.length === 1 ? '' : 's'}</span><i /><span>{project.tracks.length} tracks</span><span className="timeline-status-right">{formatTimecode(playhead, project.frameRate)} <span>·</span> {Math.round(zoom * 100 / pxPerFrameDefault)}%</span></div>
        </section>
      </div>

      <footer className="statusbar"><div className="statusbar-left"><span className="ready-check"><Check size={11} /></span><span>{notice || 'Ready'}</span></div><div className="statusbar-right"><span>LOCAL ONLY</span><i /> <span>24 FPS</span></div></footer>

      {showExportInfo && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowExportInfo(false) }}><section className="export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title"><div className="dialog-top"><div className="dialog-icon"><Download size={18} /></div><button className="icon-action" type="button" aria-label="Close export dialog" onClick={() => setShowExportInfo(false)}><X size={17} /></button></div><h2 id="export-title">Render video</h2><p>This workspace can preview local source media and save editable <code>.vcut</code> projects. A video render requires the native FFmpeg engine, which is not installed in this environment.</p><div className="render-requirement"><span className="requirement-dot" /><div><strong>MP4 / H.264</strong><span>Unavailable · no validated encoder detected</span></div></div><div className="dialog-actions"><button className="dialog-secondary" type="button" onClick={() => setShowExportInfo(false)}>Close</button><button className="dialog-primary" type="button" onClick={() => { setShowExportInfo(false); saveProject() }}><Download size={14} />Save project instead</button></div></section></div>}
    </main>
  )
}

export default App
