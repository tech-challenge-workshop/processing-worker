import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { InMemoryDuplicateChecker } from './in-memory-duplicate-checker';
import { ValidationConsumer } from './validation.consumer';

@Module({
  imports: [MessagingModule],
  providers: [
    ValidationConsumer,
    {
      provide: 'DUPLICATE_CHECKER',
      useClass: InMemoryDuplicateChecker,
    },
  ],
  exports: [ValidationConsumer, 'DUPLICATE_CHECKER'],
})
export class ValidationModule {}
