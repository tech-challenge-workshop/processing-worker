import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { ValidationModule } from '../validation/validation.module';
import { DeterministicFramePackager } from './deterministic-frame-packager';
import { ProcessingConsumer } from './processing.consumer';

@Module({
  imports: [MessagingModule, ValidationModule],
  controllers: [ProcessingConsumer],
  providers: [
    {
      provide: 'FRAME_PACKAGER',
      useClass: DeterministicFramePackager,
    },
  ],
})
export class ProcessingModule {}
