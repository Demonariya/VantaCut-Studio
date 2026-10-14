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
}

export interface Track {
  id: string
  name: string
  kind: TrackKind
  locked: boolean
  muted: boolean
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
  | { type: 'update-asset'; assetId: string; values: Partial<Pick<MediaAsset, 'thumbnail' | 'width' | 'height'>> }
  | { type: 'add-clip'; clip: Clip }
  | { type: 'delete-clip'; clipId: string }
  | { type: 'split-clip'; clipId: string; atFrame: number; rightClipId: string }
  | { type: 'move-clip'; clipId: string; startFrame: number; trackId?: string }
  | { type: 'trim-clip'; clipId: string; edge: 'in' | 'out'; atFrame: number }
  | { type: 'ripple-delete'; clipId: string }
  | { type: 'update-clip'; clipId: string; values: Partial<Pick<Clip, 'brightness' | 'contrast' | 'saturation' | 'opacity' | 'volume'>> }
  | { type: 'update-track'; trackId: string; values: Partial<Pick<Track, 'name' | 'locked' | 'muted' | 'hidden'>> }

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
      { id: 'a1', name: 'A1', kind: 'audio', locked: false, muted: false, hidden: false },
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

export function applyCommand(project: Project, command: TimelineCommand): Project {
  switch (command.type) {
    case 'rename-project':
      return command.name === project.name ? project : { ...project, name: command.name, updatedAt: new Date().toISOString() }
    case 'add-asset':
      return project.assets.some((asset) => asset.id === command.asset.id)
        ? project
        : { ...project, assets: [...project.assets, command.asset], updatedAt: new Date().toISOString() }
    case 'update-asset': {
      const index = project.assets.findIndex((asset) => asset.id === command.assetId)
      if (index < 0) return project
      const assets = [...project.assets]
      assets[index] = { ...assets[index], ...command.values }
      return { ...project, assets, updatedAt: new Date().toISOString() }
    }
    case 'add-clip': {
      if (project.clips.some((clip) => clip.id === command.clip.id)) return project
      const track = project.tracks.find((item) => item.id === command.clip.trackId)
      const asset = project.assets.find((item) => item.id === command.clip.assetId)
      if (!track || !asset || track.locked || command.clip.durationFrames < 1
        || (track.kind === 'audio') !== (asset.kind === 'audio')
        || command.clip.sourceInFrame < 0
        || command.clip.sourceInFrame + command.clip.durationFrames > asset.durationFrames) return project
      return { ...project, clips: [...project.clips, command.clip], updatedAt: new Date().toISOString() }
    }
    case 'delete-clip': {
      const clip = project.clips.find((item) => item.id === command.clipId)
      if (!clip || !canEditClip(project, clip)) return project
      return { ...project, clips: project.clips.filter((clip) => clip.id !== command.clipId), updatedAt: new Date().toISOString() }
    }
    case 'split-clip': {
      const clip = project.clips.find((item) => item.id === command.clipId)
      if (!clip || !canEditClip(project, clip) || project.clips.some((item) => item.id === command.rightClipId)
        || command.atFrame <= clip.startFrame || command.atFrame >= clip.startFrame + clip.durationFrames) return project
      const leftDuration = command.atFrame - clip.startFrame
      const rightClip: Clip = {
        ...clip,
        id: command.rightClipId,
        startFrame: command.atFrame,
        sourceInFrame: clip.sourceInFrame + leftDuration,
        durationFrames: clip.durationFrames - leftDuration,
      }
      return replaceClip({ ...project, clips: [...project.clips, rightClip] }, clip.id, (current) => ({ ...current, durationFrames: leftDuration }))
    }
    case 'move-clip': {
      const clip = project.clips.find((item) => item.id === command.clipId)
      const track = command.trackId ? project.tracks.find((item) => item.id === command.trackId) : undefined
      const asset = clip && project.assets.find((item) => item.id === clip.assetId)
      if (!clip || !canEditClip(project, clip) || (command.trackId && (!track || track.locked))
        || (track && asset && ((track.kind === 'audio') !== (asset.kind === 'audio')))) return project
      return replaceClip(project, command.clipId, (clip) => ({
        ...clip,
        startFrame: Math.max(0, Math.round(command.startFrame)),
        trackId: command.trackId ?? clip.trackId,
      }))
    }
    case 'trim-clip': {
      const clip = project.clips.find((item) => item.id === command.clipId)
      if (!clip || !canEditClip(project, clip)) return project
      if (command.edge === 'in') {
        const start = Math.max(Math.max(0, clip.startFrame - clip.sourceInFrame), Math.min(command.atFrame, clip.startFrame + clip.durationFrames - 1))
        const delta = start - clip.startFrame
        if (delta === 0) return project
        return replaceClip(project, clip.id, (current) => ({
          ...current,
          startFrame: start,
          sourceInFrame: current.sourceInFrame + delta,
          durationFrames: current.durationFrames - delta,
        }))
      }
      const asset = project.assets.find((item) => item.id === clip.assetId)
      const sourceEnd = clip.startFrame + (asset?.durationFrames ?? clip.sourceInFrame + clip.durationFrames) - clip.sourceInFrame
      const end = Math.max(clip.startFrame + 1, Math.min(command.atFrame, sourceEnd))
      return end === clip.startFrame + clip.durationFrames
        ? project
        : replaceClip(project, clip.id, (current) => ({ ...current, durationFrames: end - current.startFrame }))
    }
    case 'ripple-delete': {
      const clip = project.clips.find((item) => item.id === command.clipId)
      if (!clip || !canEditClip(project, clip)) return project
      const end = clip.startFrame + clip.durationFrames
      return {
        ...project,
        clips: project.clips
          .filter((item) => item.id !== clip.id)
          .map((item) => item.trackId === clip.trackId && item.startFrame >= end
            ? { ...item, startFrame: item.startFrame - clip.durationFrames }
            : item),
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
