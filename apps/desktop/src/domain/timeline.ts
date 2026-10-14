export interface FrameRate {
  numerator: number
  denominator: number
}

export type MediaKind = 'video' | 'audio' | 'image'
export type TrackKind = 'video' | 'audio'

export interface MediaAsset {
  id: string
  name: string
  kind: MediaKind
  mimeType: string
  fileSize: number
  modifiedAt: number
  durationFrames: number
  width: number
  height: number
  sourceFrameRate: FrameRate | null
  thumbnail: string | null
}

export interface Clip {
  id: string
  assetId: string
  trackId: string
  startFrame: number
  sourceInFrame: number
  durationFrames: number
  brightness: number
  contrast: number
  saturation: number
  opacity: number
  volume: number
  muted?: boolean
  linkGroupId?: string
  enabled?: boolean
}

export interface Track {
  id: string
  name: string
  kind: TrackKind
  locked: boolean
  muted: boolean
  solo?: boolean
  hidden: boolean
}

export interface Project {
  schemaVersion: 1
  id: string
  name: string
  frameRate: FrameRate
  width: number
  height: number
  audioSampleRate: number
  assets: MediaAsset[]
  tracks: Track[]
  clips: Clip[]
  updatedAt: string
}

export type TimelineCommand =
  | { type: 'rename-project'; name: string }
  | { type: 'add-asset'; asset: MediaAsset }
  | { type: 'remove-asset'; assetId: string }
  | { type: 'update-asset'; assetId: string; values: Partial<Pick<MediaAsset, 'name' | 'thumbnail' | 'width' | 'height'>> }
  | { type: 'add-clip'; clip: Clip }
  | { type: 'add-clips'; clips: Clip[] }
  | { type: 'add-track'; track: Track; index?: number }
  | { type: 'remove-track'; trackId: string }
  | { type: 'delete-clip'; clipId: string }
  | { type: 'split-clip'; clipId: string; atFrame: number; rightClipId: string; rightClipIds?: Record<string, string> }
  | { type: 'move-clip'; clipId: string; startFrame: number; trackId?: string }
  | { type: 'trim-clip'; clipId: string; edge: 'in' | 'out'; atFrame: number }
  | { type: 'ripple-delete'; clipId: string }
  | { type: 'update-clip'; clipId: string; values: Partial<Pick<Clip, 'brightness' | 'contrast' | 'saturation' | 'opacity' | 'volume' | 'muted' | 'enabled' | 'linkGroupId'>> }
  | { type: 'update-track'; trackId: string; values: Partial<Pick<Track, 'name' | 'locked' | 'muted' | 'solo' | 'hidden'>> }

export interface History {
  past: Project[]
  present: Project
  future: Project[]
}

export function createProject(name = 'Untitled sequence'): Project {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name,
    frameRate: { numerator: 24, denominator: 1 },
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    assets: [],
    tracks: [
      { id: 'v1', name: 'V1', kind: 'video', locked: false, muted: false, hidden: false },
      { id: 'v2', name: 'V2', kind: 'video', locked: false, muted: false, hidden: false },
      { id: 'a1', name: 'A1', kind: 'audio', locked: false, muted: false, solo: false, hidden: false },
    ],
    clips: [],
    updatedAt: now,
  }
}

export function framesToSeconds(frame: number, rate: FrameRate): number {
  return (frame * rate.denominator) / rate.numerator
}

export function secondsToFrames(seconds: number, rate: FrameRate): number {
  return Math.round((seconds * rate.numerator) / rate.denominator)
}

export function formatTimecode(frame: number, rate: FrameRate): string {
  const nominalRate = Math.round(rate.numerator / rate.denominator)
  const safeFrame = Math.max(0, Math.floor(frame))
  const totalSeconds = Math.floor(safeFrame / nominalRate)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const frameNumber = safeFrame % nominalRate
  return [hours, minutes, seconds, frameNumber].map((value) => String(value).padStart(2, '0')).join(':')
}

export function sequenceDurationFrames(project: Project): number {
  return project.clips.reduce((end, clip) => Math.max(end, clip.startFrame + clip.durationFrames), 0)
}

export function findClipAtFrame(project: Project, frame: number, kind?: TrackKind): Clip | undefined {
  return project.clips.find((clip) => {
    const track = project.tracks.find((item) => item.id === clip.trackId)
    return (!kind || track?.kind === kind) && frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames
  })
}

function replaceClip(project: Project, clipId: string, update: (clip: Clip) => Clip): Project {
  const index = project.clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) return project
  const clips = [...project.clips]
  clips[index] = update(clips[index])
  return { ...project, clips, updatedAt: new Date().toISOString() }
}

function canEditClip(project: Project, clip: Clip): boolean {
  return project.tracks.some((track) => track.id === clip.trackId && !track.locked)
}

function isValidClip(project: Project, clip: Clip): boolean {
  const track = project.tracks.find((item) => item.id === clip.trackId)
  const asset = project.assets.find((item) => item.id === clip.assetId)
  if (!track || !asset || track.locked || (track.kind === 'video' && asset.kind === 'audio')
    || (track.kind === 'audio' && asset.kind === 'image')) return false
  return clip.durationFrames >= 1 && clip.sourceInFrame >= 0
    && clip.sourceInFrame + clip.durationFrames <= asset.durationFrames
}

function linkedClips(project: Project, clip: Clip): Clip[] {
  if (!clip.linkGroupId) return [clip]
  return project.clips.filter((item) => item.linkGroupId === clip.linkGroupId)
}

export function applyCommand(project: Project, command: TimelineCommand): Project {
  switch (command.type) {
    case 'rename-project':
      return command.name === project.name ? project : { ...project, name: command.name, updatedAt: new Date().toISOString() }
    case 'add-asset':
      return project.assets.some((asset) => asset.id === command.asset.id)
        ? project
        : { ...project, assets: [...project.assets, command.asset], updatedAt: new Date().toISOString() }
    case 'remove-asset':
      if (project.clips.some((clip) => clip.assetId === command.assetId)) return project
      return { ...project, assets: project.assets.filter((asset) => asset.id !== command.assetId), updatedAt: new Date().toISOString() }
    case 'update-asset': {
      const index = project.assets.findIndex((asset) => asset.id === command.assetId)
      if (index < 0) return project
      const assets = [...project.assets]
      assets[index] = { ...assets[index], ...command.values }
      return { ...project, assets, updatedAt: new Date().toISOString() }
    }
    case 'add-clip': {
      if (project.clips.some((clip) => clip.id === command.clip.id)) return project
      if (!isValidClip(project, command.clip)) return project
      return { ...project, clips: [...project.clips, command.clip], updatedAt: new Date().toISOString() }
    }
    case 'add-clips': {
      const ids = new Set(project.clips.map((clip) => clip.id))
      for (const clip of command.clips) {
        if (ids.has(clip.id) || !isValidClip(project, clip)) return project
        ids.add(clip.id)
      }
      return { ...project, clips: [...project.clips, ...command.clips], updatedAt: new Date().toISOString() }
    }
    case 'add-track': {
      if (project.tracks.some((track) => track.id === command.track.id)) return project
      const tracks = [...project.tracks]
      tracks.splice(Math.max(0, Math.min(command.index ?? tracks.length, tracks.length)), 0, command.track)
      return { ...project, tracks, updatedAt: new Date().toISOString() }
    }
    case 'remove-track': {
      const track = project.tracks.find((item) => item.id === command.trackId)
      if (!track || project.tracks.filter((item) => item.kind === track.kind).length <= 1) return project
      return {
        ...project,
        tracks: project.tracks.filter((item) => item.id !== command.trackId),
        clips: project.clips.filter((clip) => clip.trackId !== command.trackId),
        updatedAt: new Date().toISOString(),
      }
    }
    case 'delete-clip': {
      const clip = project.clips.find((item) => item.id === command.clipId)
      if (!clip || !canEditClip(project, clip)) return project
      const group = new Set(linkedClips(project, clip).map((item) => item.id))
      return { ...project, clips: project.clips.filter((item) => !group.has(item.id)), updatedAt: new Date().toISOString() }
    }
    case 'split-clip': {
      const clip = project.clips.find((item) => item.id === command.clipId)
      if (!clip || !canEditClip(project, clip) || project.clips.some((item) => item.id === command.rightClipId)
        || command.atFrame <= clip.startFrame || command.atFrame >= clip.startFrame + clip.durationFrames) return project
      const group = linkedClips(project, clip)
      if (group.length > 1 && group.some((item) => !canEditClip(project, item)
        || (item.id !== clip.id && !command.rightClipIds?.[item.id]))) return project
      const rightClips = group.map((item) => {
        const leftDuration = command.atFrame - item.startFrame
        return {
          ...item,
          id: item.id === clip.id ? command.rightClipId : command.rightClipIds?.[item.id] ?? '',
          startFrame: command.atFrame,
          sourceInFrame: item.sourceInFrame + leftDuration,
          durationFrames: item.durationFrames - leftDuration,
        }
      })
      if (rightClips.some((item) => !item.id || project.clips.some((existing) => existing.id === item.id))) return project
      const groupIds = new Set(group.map((item) => item.id))
      const leftClips = group.map((item) => ({ ...item, durationFrames: command.atFrame - item.startFrame }))
      return { ...project, clips: [...project.clips.filter((item) => !groupIds.has(item.id)), ...leftClips, ...rightClips], updatedAt: new Date().toISOString() }
    }
    case 'move-clip': {
      const clip = project.clips.find((item) => item.id === command.clipId)
      const track = command.trackId ? project.tracks.find((item) => item.id === command.trackId) : undefined
      const asset = clip && project.assets.find((item) => item.id === clip.assetId)
      if (!clip || !canEditClip(project, clip) || (command.trackId && (!track || track.locked))
        || (track?.kind === 'video' && asset?.kind === 'audio') || (track?.kind === 'audio' && asset?.kind === 'image')) return project
      const delta = Math.max(0, Math.round(command.startFrame)) - clip.startFrame
      const groupIds = new Set(linkedClips(project, clip).map((item) => item.id))
      return {
        ...project,
        clips: project.clips.map((item) => !groupIds.has(item.id) ? item : {
          ...item,
          startFrame: Math.max(0, item.startFrame + delta),
          trackId: item.id === clip.id ? command.trackId ?? item.trackId : item.trackId,
        }),
        updatedAt: new Date().toISOString(),
      }
    }
    case 'trim-clip': {
      const clip = project.clips.find((item) => item.id === command.clipId)
      if (!clip || !canEditClip(project, clip)) return project
      const group = linkedClips(project, clip)
      if (group.some((item) => !canEditClip(project, item))) return project
      const groupIds = new Set(group.map((item) => item.id))
      const updated = group.map((item) => {
        if (command.edge === 'in') {
          const start = Math.max(Math.max(0, item.startFrame - item.sourceInFrame), Math.min(command.atFrame, item.startFrame + item.durationFrames - 1))
          const delta = start - item.startFrame
          return { ...item, startFrame: start, sourceInFrame: item.sourceInFrame + delta, durationFrames: item.durationFrames - delta }
        }
        const asset = project.assets.find((asset) => asset.id === item.assetId)
        const sourceEnd = item.startFrame + (asset?.durationFrames ?? item.sourceInFrame + item.durationFrames) - item.sourceInFrame
        const end = Math.max(item.startFrame + 1, Math.min(command.atFrame, sourceEnd))
        return { ...item, durationFrames: end - item.startFrame }
      })
      if (updated.every((item, index) => item.startFrame === group[index].startFrame && item.durationFrames === group[index].durationFrames && item.sourceInFrame === group[index].sourceInFrame)) return project
      return { ...project, clips: project.clips.map((item) => groupIds.has(item.id) ? updated.find((candidate) => candidate.id === item.id)! : item), updatedAt: new Date().toISOString() }
    }
    case 'ripple-delete': {
      const clip = project.clips.find((item) => item.id === command.clipId)
      if (!clip || !canEditClip(project, clip)) return project
      const group = linkedClips(project, clip)
      if (group.some((item) => !canEditClip(project, item))) return project
      const removedIds = new Set(group.map((item) => item.id))
      const rippleByTrack = new Map(group.map((item) => [item.trackId, item]))
      return {
        ...project,
        clips: project.clips
          .filter((item) => !removedIds.has(item.id))
          .map((item) => {
            const removed = rippleByTrack.get(item.trackId)
            return removed && item.startFrame >= removed.startFrame + removed.durationFrames
              ? { ...item, startFrame: item.startFrame - removed.durationFrames }
              : item
          }),
        updatedAt: new Date().toISOString(),
      }
    }
    case 'update-clip': {
      const clip = project.clips.find((item) => item.id === command.clipId)
      if (!clip || !canEditClip(project, clip)) return project
      return replaceClip(project, command.clipId, (clip) => ({ ...clip, ...command.values }))
    }
    case 'update-track': {
      const index = project.tracks.findIndex((track) => track.id === command.trackId)
      if (index < 0) return project
      const tracks = [...project.tracks]
      tracks[index] = { ...tracks[index], ...command.values }
      return { ...project, tracks, updatedAt: new Date().toISOString() }
    }
  }
}

export function commit(history: History, command: TimelineCommand): History {
  const next = applyCommand(history.present, command)
  if (next === history.present) return history
  return { past: [...history.past.slice(-99), history.present], present: next, future: [] }
}

export function undo(history: History): History {
  const previous = history.past.at(-1)
  if (!previous) return history
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] }
}

export function redo(history: History): History {
  const next = history.future[0]
  if (!next) return history
  return { past: [...history.past, history.present], present: next, future: history.future.slice(1) }
}

export function isProject(value: unknown): value is Project {
  if (!value || typeof value !== 'object') return false
  const project = value as Partial<Project>
  return project.schemaVersion === 1
    && typeof project.id === 'string'
    && typeof project.name === 'string'
    && Array.isArray(project.assets)
    && Array.isArray(project.tracks)
    && Array.isArray(project.clips)
    && typeof project.frameRate?.numerator === 'number'
    && project.frameRate.numerator > 0
    && typeof project.frameRate.denominator === 'number'
    && project.frameRate.denominator > 0
}
