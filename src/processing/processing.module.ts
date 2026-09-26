import { Module } from '@nestjs/common';
import { ChildProcessRunner } from '../media/child-process.runner';
import {
  FFMPEG_OPTIONS,
  FfmpegFrameExtractor,
  ffmpegOptionsFromEnv,
} from '../media/ffmpeg-frame-extractor';
import { TempWorkspace } from '../media/temp-workspace';
import { ZipBuilder } from '../media/zip-builder';
import { MessagingModule } from '../messaging/messaging.module';
import { StorageModule } from '../storage/storage.module';
import { ValidationModule } from '../validation/validation.module';
import { MediaFramePackager } from './media-frame-packager';
import { ProcessingConsumer } from './processing.consumer';
import { ShutdownSignal } from './shutdown-signal';

// DeterministicFramePackager is a test double and the home of the key
// format. It is never bound here, and test/composition.e2e-spec.ts asserts
// which packager the root selects.
@Module({
  imports: [MessagingModule, StorageModule, ValidationModule],
  controllers: [ProcessingConsumer],
  providers: [
    ChildProcessRunner,
    TempWorkspace,
    FfmpegFrameExtractor,
    { provide: FFMPEG_OPTIONS, useFactory: () => ffmpegOptionsFromEnv() },
    ZipBuilder,
    ShutdownSignal,
    {
      provide: 'FRAME_PACKAGER',
      useClass: MediaFramePackager,
    },
  ],
})
export class ProcessingModule {}
