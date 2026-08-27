import { Module } from '@nestjs/common';
import { InMemoryDuplicateChecker } from './in-memory-duplicate-checker';
import { FakeEventPublisher } from '../messaging/fake-event-publisher';
import { ValidationConsumer } from './validation.consumer';

@Module({
  providers: [
    ValidationConsumer,
    {
      provide: 'DUPLICATE_CHECKER',
      useClass: InMemoryDuplicateChecker,
    },
    {
      provide: 'EVENT_PUBLISHER',
      useClass: FakeEventPublisher,
    },
  ],
  exports: [ValidationConsumer],
})
export class ValidationModule {}
