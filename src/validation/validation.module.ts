import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { InMemoryDuplicateChecker } from './in-memory-duplicate-checker';
import { ValidationConsumer } from './validation.consumer';

@Module({
  imports: [MessagingModule],
  controllers: [ValidationConsumer],
  providers: [
    {
      provide: 'DUPLICATE_CHECKER',
      useClass: InMemoryDuplicateChecker,
    },
  ],
  exports: ['DUPLICATE_CHECKER'],
})
export class ValidationModule {}
