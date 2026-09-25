import { Module } from '@nestjs/common';
import { ChildProcessRunner } from '../media/child-process.runner';
import {
  FFPROBE_OPTIONS,
  FfprobeProbe,
  ffprobeOptionsFromEnv,
} from '../media/ffprobe-probe';
import { TempWorkspace } from '../media/temp-workspace';
import { MessagingModule } from '../messaging/messaging.module';
import { StorageModule } from '../storage/storage.module';
import {
  FfprobeVideoValidator,
  VALIDATION_LIMITS,
  validationLimitsFromEnv,
} from './ffprobe-video-validator';
import { InMemoryDuplicateChecker } from './in-memory-duplicate-checker';
import { ValidationConsumer } from './validation.consumer';

// AcceptAllVideoValidator is a test double only. It is never bound here, and
// test/composition.e2e-spec.ts asserts which validator the root selects.
@Module({
  imports: [MessagingModule, StorageModule],
  controllers: [ValidationConsumer],
  providers: [
    ChildProcessRunner,
    TempWorkspace,
    FfprobeProbe,
    { provide: FFPROBE_OPTIONS, useFactory: () => ffprobeOptionsFromEnv() },
    {
      provide: VALIDATION_LIMITS,
      useFactory: () => validationLimitsFromEnv(),
    },
    {
      provide: 'DUPLICATE_CHECKER',
      useClass: InMemoryDuplicateChecker,
    },
    {
      provide: 'VIDEO_VALIDATOR',
      useClass: FfprobeVideoValidator,
    },
  ],
  exports: ['DUPLICATE_CHECKER', 'VIDEO_VALIDATOR'],
})
export class ValidationModule {}
