import type { CandidateSegment, CropRange } from '../core/models';
export interface AudioInspection { duration: number; needsCrop: boolean; candidates: CandidateSegment[] }
export interface AudioCropperPort { inspect(blob: Blob): Promise<AudioInspection>; crop(blob: Blob, range: CropRange): Promise<{ blob: Blob; duration: number }> }
