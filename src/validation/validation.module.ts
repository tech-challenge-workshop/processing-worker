import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { InMemoryDuplicateChecker } from './in-memory-duplicate-checker';
import { ValidationConsumer } from './validation.consumer';
import { AcceptAllVideoValidator } from './accept-all-video-validator';

@Module({
  imports: [MessagingModule],
  controllers: [ValidationConsumer],
  providers: [
    {
      provide: 'DUPLICATE_CHECKER',
      useClass: InMemoryDuplicateChecker,
    },
    {
      provide: 'VIDEO_VALIDATOR',
      useClass: AcceptAllVideoValidator,
    },
  ],
  exports: ['DUPLICATE_CHECKER', 'VIDEO_VALIDATOR'],
})
export class ValidationModule {}
