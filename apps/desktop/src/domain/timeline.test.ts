import { describe, expect, it } from 'vitest'
import {
  applyCommand,
  commit,
  createProject,
  formatTimecode,
  redo,
  secondsToFrames,
  undo,
  type Clip,
} from './timeline'

const clip: Clip = {
  id: 'clip-1',
  assetId: 'asset-1',
  trackId: 'v1',
  startFrame: 48,
  sourceInFrame: 12,
  durationFrames: 120,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  opacity: 1,
  volume: 1,
}

function projectWithClip() {
  const project = createProject()
  project.assets.push({
    id: 'asset-1', name: 'take.mp4', kind: 'video', mimeType: 'video/mp4', fileSize: 1024,
    modifiedAt: 0, durationFrames: 300, width: 1920, height: 1080,
    sourceFrameRate: { numerator: 24, denominator: 1 }, thumbnail: null,
  })
  project.clips.push(clip)
  return project
}

describe('frame-accurate timeline model', () => {
  it('converts rational frame rates without using seconds as stored time', () => {
    expect(secondsToFrames(10, { numerator: 30000, denominator: 1001 })).toBe(300)
    expect(formatTimecode(61, { numerator: 24, denominator: 1 })).toBe('00:00:02:13')
  })

  it('splits a clip while keeping source continuity', () => {
    const result = applyCommand(projectWithClip(), { type: 'split-clip', clipId: 'clip-1', atFrame: 108, rightClipId: 'clip-2' })
    expect(result.clips).toHaveLength(2)
    expect(result.clips.find((item) => item.id === 'clip-1')).toMatchObject({ startFrame: 48, sourceInFrame: 12, durationFrames: 60 })
    expect(result.clips.find((item) => item.id === 'clip-2')).toMatchObject({ startFrame: 108, sourceInFrame: 72, durationFrames: 60 })
  })

  it('trims the in edge in both sequence and source time', () => {
    const result = applyCommand(projectWithClip(), { type: 'trim-clip', clipId: 'clip-1', edge: 'in', atFrame: 72 })
    expect(result.clips[0]).toMatchObject({ startFrame: 72, sourceInFrame: 36, durationFrames: 96 })
  })

  it('extends a trimmed in edge only into available source frames', () => {
    const result = applyCommand(projectWithClip(), { type: 'trim-clip', clipId: 'clip-1', edge: 'in', atFrame: 24 })
    expect(result.clips[0]).toMatchObject({ startFrame: 36, sourceInFrame: 0, durationFrames: 132 })
  })

  it('moves a clip and preserves it through undo and redo', () => {
    const history = commit({ past: [], present: projectWithClip(), future: [] }, { type: 'move-clip', clipId: 'clip-1', startFrame: 200 })
    expect(history.present.clips[0].startFrame).toBe(200)
    expect(undo(history).present.clips[0].startFrame).toBe(48)
    expect(redo(undo(history)).present.clips[0].startFrame).toBe(200)
  })

  it('ripple deletes on the same track without shifting other tracks', () => {
    const project = projectWithClip()
    project.clips.push({ ...clip, id: 'later', startFrame: 200 })
    project.clips.push({ ...clip, id: 'audio', trackId: 'a1', startFrame: 200 })
    const result = applyCommand(project, { type: 'ripple-delete', clipId: 'clip-1' })
    expect(result.clips.find((item) => item.id === 'later')?.startFrame).toBe(80)
    expect(result.clips.find((item) => item.id === 'audio')?.startFrame).toBe(200)
  })

  it('rejects edits on locked tracks', () => {
    const project = projectWithClip()
    project.tracks[0].locked = true
    expect(applyCommand(project, { type: 'delete-clip', clipId: 'clip-1' })).toBe(project)
    expect(applyCommand(project, { type: 'split-clip', clipId: 'clip-1', atFrame: 80, rightClipId: 'clip-2' })).toBe(project)
    expect(applyCommand(project, { type: 'move-clip', clipId: 'clip-1', startFrame: 90 })).toBe(project)
  })

  it('never trims a clip beyond the available source frames', () => {
    const project = projectWithClip()
    const result = applyCommand(project, { type: 'trim-clip', clipId: 'clip-1', edge: 'out', atFrame: 999 })
    expect(result.clips[0].durationFrames).toBe(288)
  })

  it('rejects clips on a track with the wrong media kind', () => {
    const project = projectWithClip()
    expect(applyCommand(project, { type: 'add-clip', clip: { ...clip, id: 'bad-kind', trackId: 'a1' } })).toBe(project)
  })
})
